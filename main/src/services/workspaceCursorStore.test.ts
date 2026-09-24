import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceCursorStore } from './workspaceCursorStore';

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function cursorFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-workspace-cursors-'));
  tempDirectories.push(directory);
  return path.join(directory, 'workspace-cursors.json');
}

describe('WorkspaceCursorStore', () => {
  it('persists cursors atomically with private permissions', () => {
    const file = cursorFile();
    new WorkspaceCursorStore(file).create('monitor', 12, 'epoch-one');

    expect(new WorkspaceCursorStore(file).get('monitor')).toMatchObject({ gen: 12, epoch: 'epoch-one' });
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['workspace-cursors.json']);
  });

  it('commits a lazily pending cursor on the next read', () => {
    const file = cursorFile();
    const store = new WorkspaceCursorStore(file);
    store.create('monitor', 4, 'epoch-one');
    store.advance('monitor', 7, 'epoch-one', true);
    expect(store.get('monitor')).toMatchObject({ gen: 4, pendingGen: 7 });
    expect(store.commitPending('monitor')).toMatchObject({ gen: 7 });
  });

  it('does not regress a cursor when concurrent deliveries finish out of order', () => {
    const store = new WorkspaceCursorStore(cursorFile());
    store.create('monitor', 4, 'epoch-one');
    store.advance('monitor', 9, 'epoch-one', true);
    store.advance('monitor', 7, 'epoch-one', true);

    expect(store.commitPending('monitor')).toMatchObject({ gen: 9 });
  });

  it('evicts cursors idle for more than 30 days', () => {
    const file = cursorFile();
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const store = new WorkspaceCursorStore(file, () => now);
    store.create('stale', 1, 'epoch-one');
    now += 31 * 24 * 60 * 60 * 1000;
    expect(store.evictStale()).toEqual(['stale']);
    expect(store.get('stale')).toBeUndefined();
  });
});
