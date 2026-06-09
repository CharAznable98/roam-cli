import type { ApprovalKind } from "@roamcli/protocol";
import { parseAnsiChunk, type ParsedChunk } from "./ansi.js";

export interface ApprovalRequestDraft {
  kind: ApprovalKind;
  summary: string;
  payload: Record<string, unknown>;
}

export interface ArtifactDraft {
  path: string;
  kind?: "patch" | "file" | "log";
  mimeType?: string;
}

export interface OutputParseResult {
  chunk: ParsedChunk;
  approvals: readonly ApprovalRequestDraft[];
  artifacts: readonly ArtifactDraft[];
}

export class OutputParser {
  #buffer = "";
  readonly #mode: string;

  public constructor(mode = "text") {
    this.#mode = mode;
  }

  public feed(chunk: string | Buffer): OutputParseResult {
    const parsed = parseAnsiChunk(chunk);
    this.#buffer += parsed.text;

    if (this.#mode === "codex-json") {
      return this.#feedCodexJson(parsed);
    }

    const approvals: ApprovalRequestDraft[] = [];
    const artifacts: ArtifactDraft[] = [];
    const completeLines = this.#completeLines();
    for (const line of completeLines) {
      const approval = parseApprovalLine(line);
      if (approval !== undefined) {
        approvals.push(approval);
        continue;
      }
      const artifact = parseArtifactLine(line);
      if (artifact !== undefined) {
        artifacts.push(artifact);
      }
    }

    return { chunk: parsed, approvals, artifacts };
  }

  #feedCodexJson(parsed: ParsedChunk): OutputParseResult {
    let text = "";
    const completeLines = this.#completeLines();
    for (const line of completeLines) {
      const event = parseJsonObject(line);
      if (event?.type !== "item.completed" || !isRecord(event.item)) {
        continue;
      }
      if (event.item.type !== "agent_message" || typeof event.item.text !== "string") {
        continue;
      }
      text += event.item.text;
      if (!text.endsWith("\n")) {
        text += "\n";
      }
    }

    return {
      chunk: {
        raw: parsed.raw,
        text,
        lines: text.split(/\r?\n/).filter((line) => line.length > 0)
      },
      approvals: [],
      artifacts: []
    };
  }

  #completeLines(): string[] {
    const parts = this.#buffer.split(/\r?\n/);
    this.#buffer = parts.pop() ?? "";
    return parts.filter((line) => line.length > 0);
  }
}

function parseApprovalLine(line: string): ApprovalRequestDraft | undefined {
  const taggedJson =
    parseTaggedJson(line, "APPROVAL_REQUEST") ??
    parseTaggedJson(line, "ROAMCLI_APPROVAL");
  const json = taggedJson ?? parseJsonObject(line);
  if (json === undefined) {
    return undefined;
  }

  const approval = isRecord(json.approval) ? json.approval : json;
  const rawType = typeof json.type === "string" ? json.type : undefined;
  if (
    taggedJson === undefined &&
    rawType !== "approvalRequested" &&
    rawType !== "approval_request" &&
    rawType !== "approval"
  ) {
    return undefined;
  }

  const kind = approval.kind === "applyPatch" ? "applyPatch" : "execCommand";
  const summary =
    typeof approval.summary === "string" && approval.summary.length > 0
      ? approval.summary
      : "Agent requested approval";
  const payload = isRecord(approval.payload)
    ? approval.payload
    : taggedJson === undefined
      ? {}
      : approval;
  return { kind, summary, payload };
}

function parseArtifactLine(line: string): ArtifactDraft | undefined {
  const json =
    parseTaggedJson(line, "ARTIFACT") ??
    parseTaggedJson(line, "ROAMCLI_ARTIFACT") ??
    parseJsonObject(line);
  if (json === undefined) {
    return undefined;
  }
  if (json.type !== "artifact" && json.type !== "artifactCreated") {
    return undefined;
  }
  if (typeof json.path !== "string" || json.path.length === 0) {
    return undefined;
  }
  return {
    path: json.path,
    kind: json.kind === "patch" || json.kind === "log" ? json.kind : "file",
    mimeType:
      typeof json.mimeType === "string"
        ? json.mimeType
        : "application/octet-stream",
  };
}

function parseTaggedJson(
  line: string,
  tag: string,
): Record<string, unknown> | undefined {
  if (line.startsWith(`${tag}:`)) {
    return parseJsonObject(line.slice(tag.length + 1).trim());
  }
  if (line.startsWith(`${tag} `)) {
    return parseJsonObject(line.slice(tag.length + 1).trim());
  }
  if (line !== tag) {
    return undefined;
  }
  return undefined;
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
