import stripAnsi from "strip-ansi";
import type { ApprovalKind, ArtifactKind } from "@roamcli/protocol";

export type ParsedAgentEvent =
  | { type: "token"; content: string }
  | { type: "message"; content: string }
  | {
      type: "toolCall";
      kind: ApprovalKind;
      summary: string;
      payload: Record<string, unknown>;
    }
  | {
      type: "artifact";
      kind: ArtifactKind;
      name: string;
      content: Buffer;
      mimeType: string;
    }
  | { type: "error"; message: string; code?: string };

export interface AgentParser {
  readonly name: string;
  readonly agent: string;
  push(chunk: string | Buffer): ParsedAgentEvent[];
  flush(): ParsedAgentEvent[];
}

export type AgentParserFactory = () => AgentParser;

export interface ParserRegistry {
  get(name: string): AgentParserFactory | undefined;
  register(name: string, factory: AgentParserFactory): void;
  names(): string[];
}

export class InMemoryParserRegistry implements ParserRegistry {
  private readonly factories = new Map<string, AgentParserFactory>();

  constructor(entries: Record<string, AgentParserFactory> = {}) {
    for (const [name, factory] of Object.entries(entries)) {
      this.register(name, factory);
    }
  }

  get(name: string): AgentParserFactory | undefined {
    return this.factories.get(name);
  }

  register(name: string, factory: AgentParserFactory): void {
    this.factories.set(name, factory);
  }

  names(): string[] {
    return [...this.factories.keys()].sort();
  }
}

export class LineParser implements AgentParser {
  readonly name: string;
  readonly agent: string;
  private buffer = "";

  constructor(agent: string, name = `${agent}-line`) {
    this.agent = agent;
    this.name = name;
  }

  push(chunk: string | Buffer): ParsedAgentEvent[] {
    this.buffer += stripAnsi(
      Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk,
    );
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    return lines.flatMap((line) => this.parseLine(line));
  }

  flush(): ParsedAgentEvent[] {
    const rest = this.buffer;
    this.buffer = "";
    return rest ? this.parseLine(rest) : [];
  }

  protected parseLine(line: string): ParsedAgentEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const approvalRaw =
      stripMarker(trimmed, "ROAMCLI_APPROVAL") ??
      stripMarker(trimmed, "APPROVAL_REQUEST");
    if (approvalRaw !== undefined) {
      return [parseApproval(approvalRaw)];
    }
    const artifactRaw =
      stripMarker(trimmed, "ROAMCLI_ARTIFACT") ??
      stripMarker(trimmed, "ARTIFACT");
    if (artifactRaw !== undefined) {
      return [parseArtifact(artifactRaw)];
    }
    const jsonApproval = parseJsonObject(trimmed);
    if (jsonApproval !== undefined && isApprovalEnvelope(jsonApproval)) {
      return [toApprovalEvent(jsonApproval)];
    }
    if (/^(error|fatal):/i.test(trimmed)) {
      return [{ type: "error", message: trimmed }];
    }
    return [{ type: "token", content: `${line}\n` }];
  }
}

export class MockParser extends LineParser {
  constructor() {
    super("mock", "mock");
  }
}

export function createDefaultRegistry(): ParserRegistry {
  return new InMemoryParserRegistry({
    mock: () => new MockParser(),
    shell: () => new LineParser("shell", "shell"),
    claude: () => new LineParser("claude", "claude"),
    codex: () => new LineParser("codex", "codex"),
    gemini: () => new LineParser("gemini", "gemini"),
    aider: () => new LineParser("aider", "aider"),
  });
}

function parseApproval(raw: string): ParsedAgentEvent {
  const parsed = parseJsonObject(raw);
  if (parsed === undefined) {
    return {
      type: "error",
      message: `Invalid approval marker: ${raw}`,
      code: "INVALID_APPROVAL_MARKER",
    };
  }
  return toApprovalEvent(parsed);
}

function parseArtifact(raw: string): ParsedAgentEvent {
  const parsed = parseJsonObject(raw);
  if (parsed === undefined) {
    return {
      type: "error",
      message: `Invalid artifact marker: ${raw}`,
      code: "INVALID_ARTIFACT_MARKER",
    };
  }
  const content = Buffer.from(String(parsed.content ?? ""), "utf8");
  return {
    type: "artifact",
    kind:
      parsed.kind === "patch" || parsed.kind === "file" ? parsed.kind : "log",
    name: String(parsed.name ?? "artifact.txt"),
    mimeType: String(parsed.mimeType ?? "text/plain"),
    content,
  };
}

function parseJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stripMarker(line: string, marker: string): string | undefined {
  if (line === marker) {
    return "";
  }
  if (line.startsWith(`${marker}:`)) {
    return line.slice(marker.length + 1).trim();
  }
  if (line.startsWith(`${marker} `)) {
    return line.slice(marker.length + 1).trim();
  }
  return undefined;
}

function toApprovalEvent(envelope: Record<string, unknown>): ParsedAgentEvent {
  const approval = isRecord(envelope.approval) ? envelope.approval : envelope;
  const payload = isRecord(approval.payload)
    ? approval.payload
    : isRecord(envelope.payload)
      ? envelope.payload
      : approval;
  return {
    type: "toolCall",
    kind: approval.kind === "applyPatch" ? "applyPatch" : "execCommand",
    summary: String(
      approval.summary ??
        approval.command ??
        envelope.summary ??
        "Tool approval requested",
    ),
    payload,
  };
}

function isApprovalEnvelope(value: Record<string, unknown>): boolean {
  return (
    value.type === "approvalRequested" ||
    value.type === "approval_request" ||
    value.type === "approval"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
