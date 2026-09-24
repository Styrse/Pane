// Run under Electron so the GPU process is the one Pane ships with:
// node_modules/.bin/electron scripts/benchmark-webgl-atlas.js
//
// Opens one xterm with the WebGL renderer and feeds it a truecolor shimmer like
// Claude Code's "thinking" animation: every frame repaints the grid in 24-bit
// colors, so nearly every cell is a glyph the texture atlas has not seen yet.
// Samples GPU and renderer process memory once a second and prints the series
// plus the peak. On macOS it reads `footprint`, which includes graphics memory
// that Electron's working-set numbers leave out.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const SECONDS = Number(process.env.DURATION ?? 90);
const XTERM_DIR = path.join(__dirname, '../frontend/node_modules/@xterm');
// Point at another addon-webgl build (for example an unpatched copy) to compare.
const WEBGL_ADDON = process.env.WEBGL_ADDON ?? path.join(XTERM_DIR, 'addon-webgl/lib/addon-webgl.js');

// Runs in the page. Every frame repaints the grid with colors it has not used
// before, the worst case of an agent's animated gradient.
function pageMain(cols, rows) {
  const term = new window.Terminal({ cols, rows, fontSize: 14, allowProposedApi: true });
  term.open(document.getElementById('term'));
  const addon = new window.WebglAddon.WebglAddon();
  term.loadAddon(addon);
  let frames = 0;
  // Private fields, read only for reporting: the atlas page sizes show whether
  // pages merged past the 4096 px cap.
  window.benchStats = () => {
    const pages = addon._renderer?._charAtlas?.pages ?? [];
    const stats = { frames, pages: pages.map((p) => p.canvas.width) };
    frames = 0;
    return stats;
  };
  const text = '✻ Thinking… reticulating splines, esc to interrupt ';
  let tick = 0;
  function frame() {
    let out = '\x1b[H';
    for (let row = 0; row < rows; row += 1) {
      out += `\x1b[${row + 1};1H`;
      for (let col = 0; col < cols; col += 1) {
        // Walk the 24-bit color space so colors never repeat within a run.
        const color = ((tick * rows + row) * cols + col) * 7919 % 0x1000000;
        out += `\x1b[38;2;${color >> 16};${(color >> 8) & 255};${color & 255}m${text[(col + row) % text.length]}`;
      }
    }
    term.write(out + '\x1b[0m');
    tick += 1;
    frames += 1;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

const UNIT_MB = { KB: 1 / 1024, MB: 1, GB: 1024 };

function footprintMb(pid) {
  const match = execFileSync('footprint', ['-p', String(pid)], { encoding: 'utf8' }).match(/Footprint: ([\d.]+) (KB|MB|GB)/);
  return Math.round(Number(match[1]) * UNIT_MB[match[2]]);
}

function memoryMb() {
  const byType = {};
  for (const metric of app.getAppMetrics()) {
    // privateBytes is Windows-only; workingSetSize is reported everywhere.
    const mb = process.platform === 'darwin'
      ? footprintMb(metric.pid)
      : Math.round((metric.memory.privateBytes ?? metric.memory.workingSetSize) / 1024);
    byType[metric.type] = (byType[metric.type] ?? 0) + mb;
  }
  return byType;
}

process.on('unhandledRejection', (error) => { console.error(error); app.exit(1); });

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1200, height: 800, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (event) => console.log('[page]', event.message));
  await win.loadURL('data:text/html,<body style="margin:0;background:black"><div id="term"></div></body>');
  const css = fs.readFileSync(path.join(XTERM_DIR, 'xterm/css/xterm.css'), 'utf8');
  await win.webContents.insertCSS(css);
  await win.webContents.executeJavaScript(fs.readFileSync(path.join(XTERM_DIR, 'xterm/lib/xterm.js'), 'utf8'));
  await win.webContents.executeJavaScript(fs.readFileSync(WEBGL_ADDON, 'utf8'));
  await win.webContents.executeJavaScript(`try { (${pageMain})(140, 12) } catch (e) { console.error(e.stack) }`);

  const samples = [];
  const started = Date.now();
  let last = started;
  while (Date.now() - started < SECONDS * 1000) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const mem = memoryMb();
    samples.push(mem);
    const stats = await win.webContents.executeJavaScript('window.benchStats()');
    const now = Date.now();
    const fps = Math.round(stats.frames / ((now - last) / 1000));
    last = now;
    console.log(`t=${Math.round((now - started) / 1000)}s gpu=${mem.GPU ?? 0}MB renderer=${mem.Tab ?? 0}MB fps=${fps} atlasPages=${stats.pages.join(',')}`);
  }
  const peak = (type) => Math.max(...samples.map((s) => s[type] ?? 0));
  console.log(JSON.stringify({ seconds: SECONDS, peakGpuMb: peak('GPU'), peakRendererMb: peak('Tab'), finalGpuMb: samples.at(-1).GPU, finalRendererMb: samples.at(-1).Tab }));
  app.quit();
});
