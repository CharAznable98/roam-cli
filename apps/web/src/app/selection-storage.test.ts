import { describe, expect, it } from "vitest";
import {
  LAST_SELECTION_STORAGE_KEY,
  loadLastSelection,
  saveLastSelection,
} from "./selection-storage";

describe("selection storage", () => {
  it("round-trips the last project and session selection", () => {
    const storage = new MemoryStorage();

    saveLastSelection(
      { projectId: "project-1", sessionId: "session-1" },
      storage,
    );

    expect(loadLastSelection(storage)).toEqual({
      projectId: "project-1",
      sessionId: "session-1",
    });
  });

  it("clears the stored selection when no project is selected", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      LAST_SELECTION_STORAGE_KEY,
      JSON.stringify({ projectId: "project-1", sessionId: "session-1" }),
    );

    saveLastSelection(undefined, storage);

    expect(loadLastSelection(storage)).toBeUndefined();
  });

  it("ignores malformed stored selections", () => {
    const storage = new MemoryStorage();
    storage.setItem(LAST_SELECTION_STORAGE_KEY, "{");

    expect(loadLastSelection(storage)).toBeUndefined();
  });
});

class MemoryStorage {
  #items = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#items.set(key, value);
  }

  removeItem(key: string): void {
    this.#items.delete(key);
  }
}
