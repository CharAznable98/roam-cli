import type { Approval, PatchHunk } from "@roamcli/protocol";

export type SessionPatchHunk = PatchHunk & {
  approvalId: string;
  sessionId: string;
};

export function mergePatchHunks(
  current: SessionPatchHunk[],
  next: SessionPatchHunk[],
): SessionPatchHunk[] {
  return next.reduce<SessionPatchHunk[]>((items, hunk) => {
    const key = `${hunk.approvalId}:${hunk.id}`;
    const existingIndex = items.findIndex(
      (item) => `${item.approvalId}:${item.id}` === key,
    );
    if (existingIndex >= 0) {
      return items.map((item, index) =>
        index === existingIndex ? hunk : item,
      );
    }
    return [...items, hunk];
  }, current);
}

export function extractPatchHunks(approvals: Approval[]): SessionPatchHunk[] {
  return approvals.flatMap((approval) => {
    if (approval.kind !== "applyPatch") {
      return [];
    }
    const payload = approval.payload as { hunks?: unknown };
    if (!Array.isArray(payload.hunks)) {
      return [];
    }
    return payload.hunks.filter(isPatchHunk).map((hunk) => ({
      ...hunk,
      approvalId: approval.id,
      sessionId: approval.sessionId,
    }));
  });
}

export function buildPatchFromHunks(hunks: PatchHunk[]): string {
  if (hunks.length === 0) {
    return "";
  }
  const grouped = new Map<string, PatchHunk[]>();
  for (const hunk of hunks) {
    grouped.set(hunk.filePath, [...(grouped.get(hunk.filePath) ?? []), hunk]);
  }
  return [...grouped.entries()]
    .flatMap(([filePath, fileHunks]) => [
      `diff --git a/${filePath} b/${filePath}`,
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      ...fileHunks.flatMap((hunk) => [hunk.header, ...hunk.lines]),
    ])
    .join("\n")
    .concat("\n");
}

export function isPatchHunk(value: unknown): value is PatchHunk {
  if (!value || typeof value !== "object") {
    return false;
  }
  const hunk = value as Partial<PatchHunk>;
  return (
    typeof hunk.id === "string" &&
    typeof hunk.filePath === "string" &&
    typeof hunk.header === "string" &&
    Array.isArray(hunk.lines) &&
    hunk.lines.every((line) => typeof line === "string") &&
    (hunk.status === undefined ||
      hunk.status === "pending" ||
      hunk.status === "accepted" ||
      hunk.status === "rejected" ||
      hunk.status === "edited")
  );
}
