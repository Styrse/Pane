// Run after pnpm build:main with the same Node version used for native modules:
// node scripts/benchmark-db-writes.js
// Times the small writes Pane makes constantly: panel state merges and session status updates.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { DatabaseService } = require('../main/dist/main/src/database/database.js');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-write-benchmark-'));
const db = new DatabaseService(path.join(directory, 'sessions.db'));
const sessionCount = 50;
const panelsPerSession = 4;
const writes = 2000;
// The service logs every migration and panel merge; keep stdout for the result.
const print = console.log;
console.log = () => {};

function measure(write) {
  const times = [];
  for (let i = 0; i < writes; i++) {
    const started = performance.now();
    write(i);
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const at = (q) => Number(times[Math.floor(q * (times.length - 1))].toFixed(3));
  const total = times.reduce((sum, t) => sum + t, 0);
  return { p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), writesPerSec: Math.round(writes / (total / 1000)) };
}

try {
  db.initialize();
  const panelIds = [];
  for (let s = 0; s < sessionCount; s++) {
    const sessionId = `session-${s}`;
    db.createSession({ id: sessionId, name: sessionId, initial_prompt: '', worktree_name: sessionId, worktree_path: directory, project_id: null, tool_type: 'none' });
    for (let p = 0; p < panelsPerSession; p++) {
      const id = `${sessionId}-panel-${p}`;
      db.createPanel({ id, sessionId, type: 'terminal', title: id, state: { isActive: false, customState: { cwd: directory } } });
      panelIds.push(id);
    }
  }
  const statuses = ['running', 'waiting', 'stopped'];
  print(JSON.stringify({
    node: process.version,
    journalMode: db.getDb().pragma('journal_mode', { simple: true }),
    synchronous: db.getDb().pragma('synchronous', { simple: true }),
    writes,
    updatePanel: measure((i) => db.updatePanel(panelIds[i % panelIds.length], { state: { isActive: i % 2 === 0, customState: { lastActivity: i } } })),
    updateSession: measure((i) => db.updateSession(`session-${i % sessionCount}`, { status: statuses[i % statuses.length] })),
  }, null, 2));
} finally {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
