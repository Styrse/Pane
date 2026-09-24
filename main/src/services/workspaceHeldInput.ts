const COMPOSER_PLACEHOLDER = /^(?:ask (?:codex|claude)\b|try\s+["“])/iu;

export function extractWorkspaceHeldInput(screenText: string): string | undefined {
  const lines = screenText.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = lines[index].trim().match(/^[>›❯▌]\s*(.+)$/u);
    const input = match?.[1]?.trim();
    if (input && !COMPOSER_PLACEHOLDER.test(input)) return input.slice(0, 120);
  }
  return undefined;
}
