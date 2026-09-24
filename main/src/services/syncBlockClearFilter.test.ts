import { describe, expect, it } from 'vitest';
import { filterSyncBlockClears, type SyncBlockClearFilterState } from './syncBlockClearFilter';

const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';
const ALT_ENTER = '\x1b[?1049h';
const ALT_LEAVE = '\x1b[?1049l';
const CLEAR = '\x1b[2J';

const fresh = (): SyncBlockClearFilterState => ({ inSyncBlock: false, filterInAltScreen: false });

describe('filterSyncBlockClears', () => {
  it('passes data through untouched outside sync blocks', () => {
    const state = fresh();
    expect(filterSyncBlockClears(state, `a${CLEAR}b`)).toBe(`a${CLEAR}b`);
    expect(state.inSyncBlock).toBe(false);
  });

  it('strips clears inside sync blocks on the normal buffer', () => {
    const state = fresh();
    expect(filterSyncBlockClears(state, `${SYNC_START}${CLEAR}frame${SYNC_END}`))
      .toBe(`${SYNC_START}frame${SYNC_END}`);
  });

  it('tracks sync block state across chunks', () => {
    const state = fresh();
    filterSyncBlockClears(state, SYNC_START);
    expect(state.inSyncBlock).toBe(true);
    expect(filterSyncBlockClears(state, `${CLEAR}x`)).toBe('x');
    filterSyncBlockClears(state, SYNC_END);
    expect(state.inSyncBlock).toBe(false);
  });

  it('keeps clears inside sync blocks while the alternate screen is active', () => {
    const state = fresh();
    filterSyncBlockClears(state, ALT_ENTER);
    expect(state.filterInAltScreen).toBe(true);
    const frame = `${SYNC_START}${CLEAR}fullscreen${SYNC_END}`;
    expect(filterSyncBlockClears(state, frame)).toBe(frame);
    expect(state.inSyncBlock).toBe(false);
  });

  it('handles alt-screen enter and a clear in the same chunk in stream order', () => {
    const state = fresh();
    const chunk = `${SYNC_START}${CLEAR}${ALT_ENTER}${CLEAR}ui${SYNC_END}`;
    expect(filterSyncBlockClears(state, chunk)).toBe(`${SYNC_START}${ALT_ENTER}${CLEAR}ui${SYNC_END}`);
    expect(state.filterInAltScreen).toBe(true);
  });

  it('resumes stripping after leaving the alternate screen', () => {
    const state = fresh();
    filterSyncBlockClears(state, ALT_ENTER);
    expect(filterSyncBlockClears(state, `${ALT_LEAVE}${SYNC_START}${CLEAR}tail${SYNC_END}`))
      .toBe(`${ALT_LEAVE}${SYNC_START}tail${SYNC_END}`);
    expect(state.filterInAltScreen).toBe(false);
  });

  it('keeps sync-block state current while on the alternate screen', () => {
    const state = fresh();
    filterSyncBlockClears(state, `${ALT_ENTER}${SYNC_START}`);
    expect(state.inSyncBlock).toBe(true);
    // Leaving alt screen inside an open sync block: subsequent clear is stripped
    expect(filterSyncBlockClears(state, `${ALT_LEAVE}${CLEAR}done${SYNC_END}`))
      .toBe(`${ALT_LEAVE}done${SYNC_END}`);
  });
});
