// Windows only. Compares Windows' built-in ConPTY with the conpty.dll and
// OpenConsole.exe that ship with node-pty (`useConptyDll`):
// node scripts/benchmark-conpty.js
//
// Each round spawns a child through node-pty that paints agent-style TUI
// frames, and records how long the output takes to arrive, the CPU used by the
// console host (conhost.exe or OpenConsole.exe) and by this process, and the
// keystroke echo latency. Rounds alternate between the two modes.
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const pty = require('@lydell/node-pty');

const ROUNDS = Number(process.env.ROUNDS ?? 3);
const FRAMES = Number(process.env.FRAMES ?? 1500);
const ECHOES = 200;
const COLS = 160;
const ROWS = 48;

// Waits for one line on stdin, then paints FRAMES full-screen redraws (about
// 12 KB each) and prints a marker. Afterwards it echoes keystrokes.
const CHILD = `
const [cols, rows, frames] = process.argv.slice(1).map(Number);
process.stdin.setRawMode(true);
process.stdin.once('data', () => {
  let out = '';
  for (let tick = 0; tick < frames; tick += 1) {
    out += '\\x1b[H';
    for (let row = 1; row < rows; row += 1) {
      const color = 16 + ((row + tick) % 216);
      out += '\\x1b[' + row + ';1H\\x1b[2K\\x1b[38;5;' + color + 'm' + (' row ' + row + ' tick ' + tick + ' ' + 'lorem ipsum dolor sit amet '.repeat(5)).slice(0, cols - 2) + '\\x1b[0m';
    }
    if (out.length > 65536) { process.stdout.write(out); out = ''; }
  }
  process.stdout.write(out + '\\x1b[' + rows + ';1HBENCH_DONE');
  process.stdin.on('data', (data) => process.stdout.write(data));
});
`;

// Summed CPU seconds of the console host processes this process started.
function hostCpu() {
  const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | ` +
    `Where-Object { $_.Name -in 'conhost.exe','OpenConsole.exe' } | ` +
    `ForEach-Object { "$($_.Name) $($_.KernelModeTime + $_.UserModeTime)" }`;
  const lines = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
    .trim().split(/\r?\n/).filter(Boolean);
  return {
    names: lines.map((line) => line.split(' ')[0]),
    seconds: lines.reduce((sum, line) => sum + Number(line.split(' ')[1]) / 1e7, 0),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function waitFor(term, text) {
  return new Promise((resolve) => {
    let seen = '';
    const sub = term.onData((data) => {
      seen = (seen + data).slice(-text.length - 64);
      if (seen.includes(text)) { sub.dispose(); resolve(); }
    });
  });
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

async function round(useConptyDll) {
  const term = pty.spawn(process.execPath, ['-e', CHILD, String(COLS), String(ROWS), String(FRAMES)], {
    name: 'xterm-256color', cols: COLS, rows: ROWS, useConptyDll,
  });
  await sleep(1500);
  const hostBefore = hostCpu();
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  let bytes = 0;
  const counter = term.onData((data) => { bytes += data.length; });
  const done = waitFor(term, 'BENCH_DONE');
  term.write('\r');
  await done;
  const drainMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  const hostAfter = hostCpu();
  counter.dispose();
  // Let the console host finish its trailing repaint before timing echoes.
  await sleep(1000);

  const echoes = [];
  for (let i = 0; i < ECHOES; i += 1) {
    const key = '%';
    const echoed = waitFor(term, key);
    const sent = performance.now();
    term.write(key);
    await echoed;
    echoes.push(performance.now() - sent);
  }
  term.kill();
  return {
    mode: useConptyDll ? 'bundled' : 'inbox',
    host: hostAfter.names.join(','),
    drainMs: Math.round(drainMs),
    receivedKb: Math.round(bytes / 1024),
    hostCpuMs: Math.round((hostAfter.seconds - hostBefore.seconds) * 1000),
    ownCpuMs: Math.round((cpu.user + cpu.system) / 1000),
    echoP50Ms: Number(percentile(echoes, 0.5).toFixed(2)),
    echoP95Ms: Number(percentile(echoes, 0.95).toFixed(2)),
  };
}

(async () => {
  const results = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    for (const useConptyDll of [false, true]) {
      const result = await round(useConptyDll);
      console.log(JSON.stringify(result));
      results.push(result);
    }
  }
  const median = (mode, key) => percentile(results.filter((r) => r.mode === mode).map((r) => r[key]), 0.5);
  for (const mode of ['inbox', 'bundled']) {
    console.log(`${mode}: drain ${median(mode, 'drainMs')} ms, received ${median(mode, 'receivedKb')} KB, host CPU ${median(mode, 'hostCpuMs')} ms, ` +
      `own CPU ${median(mode, 'ownCpuMs')} ms, echo p50 ${median(mode, 'echoP50Ms')} ms, p95 ${median(mode, 'echoP95Ms')} ms`);
  }
  process.exit(0);
})();
