export const LAST_SELECTION_STORAGE_KEY = "roamcli.lastSelection";

export type LastSelection = {
  projectId: string;
  sessionId: string;
};

type SelectionStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function loadLastSelection(
  storage: SelectionStorage = localStorage,
): LastSelection | undefined {
  try {
    const raw = storage.getItem(LAST_SELECTION_STORAGE_KEY);
    if (!raw) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return undefined;
    }
    const projectId =
      typeof parsed.projectId === "string" ? parsed.projectId : "";
    const sessionId =
      typeof parsed.sessionId === "string" ? parsed.sessionId : "";
    return projectId || sessionId ? { projectId, sessionId } : undefined;
  } catch {
    return undefined;
  }
}

export function saveLastSelection(
  selection: LastSelection | undefined,
  storage: SelectionStorage = localStorage,
): void {
  try {
    if (!selection?.projectId) {
      storage.removeItem(LAST_SELECTION_STORAGE_KEY);
      return;
    }
    storage.setItem(LAST_SELECTION_STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // localStorage can be unavailable in restricted browser contexts.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
