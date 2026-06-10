export function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function appendTerminalChunk(
  lines: string[],
  chunk: string,
  maxLines = 1000,
): string[] {
  return [...lines, stripAnsi(chunk)].slice(-maxLines);
}
