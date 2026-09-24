// Run after pnpm build:main with the same Node version used for native modules:
// node scripts/benchmark-db.js [rounds]
// Seeds a database shaped like a long-lived install (500 panes, 2,000 panels,
// 260k usage events, 360 terminal buffers), then times Pane's frequent writes
// and hot reads under each pragma set. Every round opens each set in a fresh
// process on its own copy of the seed, interleaved so machine noise hits all
// sets alike. Prints the median of each figure across rounds.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const dist = path.join(__dirname, '../main/dist/main/src');
const { DatabaseService } = require(path.join(dist, 'database/database.js'));
const { UsageAggregator } = require(path.join(dist, 'services/usage/usageAggregator.js'));

const PRAGMA_SETS = {
  current: [],
  'temp_store=MEMORY': ['temp_store = MEMORY'],
  'cache_size=-32000': ['cache_size = -32000'],
  'mmap_size=256MB': [`mmap_size = ${256 * 1024 * 1024}`],
  'optimize=0x10002': ['optimize = 0x10002'],
  'temp+cache+mmap': ['temp_store = MEMORY', 'cache_size = -32000', `mmap_size = ${256 * 1024 * 1024}`],
};
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 8, 1);
const SESSIONS = 500;
const PANELS_PER_SESSION = 4;

// The service logs every migration and panel merge; keep stdout for the result.
const print = console.log;
console.log = () => {};

function sessionId(s) {
  return `session-${s}`;
}

function panelId(s, p) {
  return `${sessionId(s)}-panel-${p}`;
}

function worktreePath(s) {
  return `/Users/dev/.pane/worktrees/project-${s % 20}/feature-branch-number-${s}`;
}

function terminalBuffer(seed) {
  return `\x1b[32m$\x1b[0m build output line ${seed} `.repeat(1500);
}

function seed(file) {
  const db = new DatabaseService(file);
  db.initialize();
  for (let s = 0; s < SESSIONS; s++) {
    db.createSession({ id: sessionId(s), name: sessionId(s), initial_prompt: '', worktree_name: sessionId(s), worktree_path: worktreePath(s), project_id: null, tool_type: 'none' });
    for (let p = 0; p < PANELS_PER_SESSION; p++) {
      db.createPanel({ id: panelId(s, p), sessionId: sessionId(s), type: 'terminal', title: panelId(s, p), state: { isActive: false, customState: { cwd: worktreePath(s) } } });
    }
  }
  for (let s = 0; s < 360; s++) {
    db.updatePanel(panelId(s, 0), { state: { customState: { scrollbackBuffer: terminalBuffer(s), serializedBuffer: terminalBuffer(s + 1) } } });
  }
  // Session timestamps are "now"; backdate them so usage attributes to panes.
  db.getDb().prepare("UPDATE sessions SET created_at = datetime(?, 'unixepoch')").run((NOW_MS - 90 * DAY_MS) / 1000);
  const insert = db.getDb().prepare(`
    INSERT INTO usage_events (id, provider, timestamp_ms, model, input_tokens, output_tokens,
      cache_read_tokens, cache_creation_tokens, agent_session_id, cwd, source_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.getDb().transaction(() => {
    for (let i = 0; i < 260_000; i++) {
      // Half the cwds belong to panes, half to directories Pane never opened.
      const cwd = i % 2 === 0 ? worktreePath(i % SESSIONS) : `/Users/dev/code/other-project-${i % 500}`;
      const source = `/Users/dev/.claude/projects/-Users-dev-code-project-${i % 3000}/0b6c1f2e-${i % 3000}.jsonl`;
      insert.run(`${source}:${i * 977}:${i}`, i % 3 === 0 ? 'claude' : 'codex', NOW_MS - (i % (80 * DAY_MS / 60_000)) * 60_000,
        `model-${i % 19}`, 1200 + (i % 900), 300 + (i % 400), 40_000 + (i % 9000), i % 7 === 0 ? 5000 : 0, `agent-${i % 4000}`, cwd, source);
    }
  })();
  db.getDb().pragma('wal_checkpoint(TRUNCATE)');
  db.close();
}

function measure(count, operation) {
  const times = [];
  for (let i = 0; i < count; i++) {
    const started = performance.now();
    operation(i);
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const at = (q) => times[Math.floor(q * (times.length - 1))];
  const total = times.reduce((sum, t) => sum + t, 0);
  return { p50: at(0.5), p95: at(0.95), perSec: count / (total / 1000) };
}

function run(seedFile, pragmas) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-db-benchmark-run-'));
  const file = path.join(directory, 'sessions.db');
  fs.copyFileSync(seedFile, file);
  const db = new DatabaseService(file);
  try {
    for (const pragma of pragmas) db.getDb().pragma(pragma);
    db.initialize();
    const usage = new UsageAggregator(db.getDb());
    const statuses = ['running', 'waiting', 'stopped'];
    // Reads run first, while this connection's page cache is still cold.
    return {
      getAllSessions: measure(200, () => db.getAllSessions()),
      getSession: measure(2000, (i) => db.getSession(sessionId(i % SESSIONS))),
      getPanelsForSession: measure(2000, (i) => db.getPanelsForSession(sessionId(i % SESSIONS))),
      getPanelBuffers: measure(360, (i) => db.getPanelBuffers(panelId(i, 0))),
      'usage by model, 30d': measure(10, () => usage.getByModel(NOW_MS - 30 * DAY_MS, NOW_MS)),
      'usage by pane, 30d': measure(5, () => usage.getByPane(NOW_MS - 30 * DAY_MS, NOW_MS)),
      'usage totals, 7d': measure(20, () => usage.getTotals(NOW_MS - 7 * DAY_MS, NOW_MS)),
      updatePanel: measure(2000, (i) => db.updatePanel(panelId(Math.floor(i / PANELS_PER_SESSION) % SESSIONS, i % PANELS_PER_SESSION), { state: { isActive: i % 2 === 0, customState: { lastActivity: i } } })),
      updateSession: measure(2000, (i) => db.updateSession(sessionId(i % SESSIONS), { status: statuses[i % statuses.length] })),
      'save terminal buffer': measure(360, (i) => db.updatePanel(panelId(i, 0), { state: { customState: { serializedBuffer: terminalBuffer(i + 7) } } })),
    };
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function format(ms) {
  return ms >= 10 ? `${ms.toFixed(0)} ms` : `${ms.toFixed(ms >= 1 ? 1 : 3)} ms`;
}

if (process.argv[2] === '--run') {
  process.stdout.write(JSON.stringify(run(process.argv[3], JSON.parse(process.argv[4]))));
} else {
  const rounds = Number(process.argv[2] ?? 5);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-db-benchmark-'));
  try {
    const seedFile = path.join(directory, 'seed.db');
    seed(seedFile);
    const results = Object.fromEntries(Object.keys(PRAGMA_SETS).map((name) => [name, []]));
    for (let round = 0; round < rounds; round++) {
      for (const [name, pragmas] of Object.entries(PRAGMA_SETS)) {
        const output = execFileSync(process.execPath, [__filename, '--run', seedFile, JSON.stringify(pragmas)], { maxBuffer: 1 << 24 });
        results[name].push(JSON.parse(output.toString()));
      }
    }
    const names = Object.keys(PRAGMA_SETS);
    print(`${process.platform} ${os.arch()}, Node ${process.version}, ${rounds} rounds, seed ${(fs.statSync(seedFile).size / 1024 / 1024).toFixed(0)} MB`);
    print(`p50 / p95 per call, median across rounds\n`);
    print(`| | ${names.join(' | ')} |`);
    print(`|---|${names.map(() => '---').join('|')}|`);
    for (const metric of Object.keys(results.current[0])) {
      const cells = names.map((name) => {
        const p50 = median(results[name].map((r) => r[metric].p50));
        const p95 = median(results[name].map((r) => r[metric].p95));
        return `${format(p50)} / ${format(p95)}`;
      });
      print(`| ${metric} | ${cells.join(' | ')} |`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
