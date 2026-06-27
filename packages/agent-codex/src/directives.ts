import type {
  ApprovalRequestDraft,
  ArtifactDraft,
} from "@roamcli/agent-plugin-sdk";

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
} {
  const approvals: ApprovalRequestDraft[] = [];
  const artifacts: ArtifactDraft[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
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
    }
  }
  return { approvals, artifacts };
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
