export interface ParsedChunk {
  raw: string;
  text: string;
  lines: readonly string[];
}

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function parseAnsiChunk(chunk: string | Buffer): ParsedChunk {
  const raw = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
  const text = raw.replace(ANSI_PATTERN, "");
  return {
    raw,
    text,
    lines: text.split(/\r?\n/).filter((line) => line.length > 0)
  };
}
