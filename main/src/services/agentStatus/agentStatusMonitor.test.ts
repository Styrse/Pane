import { describe, expect, it } from 'vitest';
import { AgentStatusMonitor } from './agentStatusMonitor';
import type { AgentDetectionResult } from '../../../../shared/types/agentStatus';

const detection = (partial: Partial<AgentDetectionResult>): AgentDetectionResult => ({
  state: 'idle',
  visibleBlocker: false,
  visibleWorking: false,
  visibleIdle: false,
  skipStateUpdate: false,
  matchedRuleId: null,
  ...partial,
});

const opts = {
  idleSettleMs: 1000,
  startupGraceMs: 3000,
};

describe('AgentStatusMonitor', () => {
  it('publishes working while PTY bytes are flowing', () => {
    const m = new AgentStatusMonitor(opts);
    m.register('p', 0);
    m.noteActivity('p', 10);
    expect(m.update('p', detection({ state: 'idle' }), 20)).toBe('working');
    expect(m.getState('p')).toBe('working');
  });

  it('settles to idle after activity stops and the hold elapses (past startup grace)', () => {
    const m = new AgentStatusMonitor(opts);
    m.register('p', 0);
    m.noteActivity('p', 4000);
    expect(m.update('p', detection({ state: 'idle' }), 4010)).toBe('working');
    expect(m.update('p', detection({ state: 'idle' }), 4999)).toBeNull();
    expect(m.update('p', detection({ state: 'idle' }), 5000)).toBe('idle');
  });

  it('publishes blocked immediately, overriding recent activity', () => {
    const m = new AgentStatusMonitor(opts);
    m.register('p', 0);
    m.noteActivity('p', 4000);
    m.update('p', detection({ state: 'idle' }), 4010); // working
    const changed = m.update('p', detection({ state: 'blocked', visibleBlocker: true }), 4020);
    expect(changed).toBe('blocked');
  });

  it('holds the prior state on skipStateUpdate detections', () => {
    const m = new AgentStatusMonitor(opts);
    m.register('p', 0);
    m.noteActivity('p', 4000);
    m.update('p', detection({ state: 'idle' }), 4010); // working
    expect(m.update('p', detection({ state: 'unknown', skipStateUpdate: true }), 4020)).toBeNull();
    expect(m.getState('p')).toBe('working');
  });

  it('suppresses premature idle during the startup grace window', () => {
    const m = new AgentStatusMonitor(opts);
    m.register('p', 0);
    // No activity, idle detection, but still inside 3s grace -> not idle yet.
    expect(m.update('p', detection({ state: 'idle' }), 500)).toBe('working');
    expect(m.getState('p')).toBe('working');
  });

  it('emits only on change', () => {
    const m = new AgentStatusMonitor(opts);
    m.register('p', 0);
    m.noteActivity('p', 4000);
    expect(m.update('p', detection({ state: 'working' }), 4010)).toBe('working');
    expect(m.update('p', detection({ state: 'working' }), 4020)).toBeNull();
  });

  it('ignores unregistered panels', () => {
    const m = new AgentStatusMonitor(opts);
    expect(m.update('ghost', detection({ state: 'working' }), 0)).toBeNull();
    expect(m.getState('ghost')).toBeUndefined();
  });

  it('suppresses a single trailing chunk after idle', () => {
    const m = new AgentStatusMonitor(opts);
    m.register('p', 0);
    m.noteActivity('p', 4000);
    m.noteActivity('p', 4010);
    expect(m.update('p', detection({ state: 'idle' }), 4020)).toBe('working');
    expect(m.update('p', detection({ state: 'idle' }), 5010)).toBe('idle');

    m.noteActivity('p', 7000);
    expect(m.update('p', detection({ state: 'idle' }), 7010)).toBeNull();
    expect(m.getState('p')).toBe('idle');
  });

  it('publishes working after two chunks wake an idle panel', () => {
    const m = new AgentStatusMonitor(opts);
    m.register('p', 0);
    expect(m.update('p', detection({ state: 'idle' }), 3000)).toBe('idle');
    m.noteActivity('p', 4000);
    expect(m.update('p', detection({ state: 'idle' }), 4010)).toBeNull();
    m.noteActivity('p', 4020);
    expect(m.update('p', detection({ state: 'idle' }), 4030)).toBe('working');
  });
});
