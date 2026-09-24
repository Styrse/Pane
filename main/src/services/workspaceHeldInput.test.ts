import { describe, expect, it } from 'vitest';
import { extractWorkspaceHeldInput } from './workspaceHeldInput';

describe('extractWorkspaceHeldInput', () => {
  it.each([
    '❯ Try "fix a bug"',
    '❯ Try “fix a bug”',
    '› Ask Codex to do anything',
    '> Ask Claude anything',
  ])('ignores idle composer placeholder %j', (screenText) => {
    expect(extractWorkspaceHeldInput(screenText)).toBeUndefined();
  });

  it('returns actual unsubmitted composer text', () => {
    expect(extractWorkspaceHeldInput('output\n❯ ship it\n')).toBe('ship it');
  });
});
