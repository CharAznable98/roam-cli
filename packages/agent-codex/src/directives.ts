import type {
  ApprovalRequestDraft,
  ArtifactDraft,
} from "@roamcli/agent-plugin-sdk";

const DIRECTIVE_TAGS = [
  "APPROVAL_REQUEST",
  "ROAMCLI_APPROVAL",
  "ARTIFACT",
  "ROAMCLI_ARTIFACT",
] as const;

export function parseJsonObject(
  value: string,
): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function parseTextDirectives(text: string): {
  approvals: ApprovalRequestDraft[];
  artifacts: ArtifactDraft[];
  displayText: string;
} {
  const approvals: ApprovalRequestDraft[] = [];
  const artifacts: ArtifactDraft[] = [];
  const displayLines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      displayLines.push(line);
      continue;
    }
    const approval = parseApprovalLine(trimmed);
    if (approval !== undefined) {
      approvals.push(approval);
      continue;
    }
    const artifact = parseArtifactLine(trimmed);
    if (artifact !== undefined) {
      artifacts.push(artifact);
      continue;
    }
    displayLines.push(line);
  }
  while (displayLines[0]?.trim().length === 0) {
    displayLines.shift();
  }
  while (displayLines.at(-1)?.trim().length === 0) {
    displayLines.pop();
  }
  return { approvals, artifacts, displayText: displayLines.join("\n") };
}

export function streamingDisplayText(text: string): string {
  let displayText = "";
  let lineStart = 0;
  for (const match of text.matchAll(/\r?\n/g)) {
    const lineEnd = match.index;
    const line = text.slice(lineStart, lineEnd);
    if (!isDirectiveLine(line.trim())) {
      displayText += `${line}\n`;
    }
    lineStart = lineEnd + match[0].length;
  }

  const finalLine = text.slice(lineStart);
  const trimmed = finalLine.trim();
  if (!isDirectiveLine(trimmed) && !couldBecomeDirective(finalLine)) {
    displayText += finalLine;
  }
  return displayText;
}

function isDirectiveLine(line: string): boolean {
  return (
    parseApprovalLine(line) !== undefined ||
    parseArtifactLine(line) !== undefined
  );
}

function couldBecomeDirective(line: string): boolean {
  const value = line.trimStart();
  if (value.length === 0 || value.startsWith("{")) {
    return true;
  }
  return DIRECTIVE_TAGS.some(
    (tag) =>
      tag.startsWith(value) ||
      value.startsWith(`${tag}:`) ||
      value.startsWith(`${tag} `),
  );
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
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
