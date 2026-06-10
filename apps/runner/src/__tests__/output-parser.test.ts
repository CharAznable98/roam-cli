import { describe, expect, it } from "vitest";
import { parseAnsiChunk } from "../ansi.js";

describe("ansi parsing", () => {
  it("strips ansi escape sequences while preserving raw chunks", () => {
    const chunk = parseAnsiChunk("\u001b[31mred\u001b[0m\n");

    expect(chunk.raw).toContain("\u001b[31m");
    expect(chunk.text).toBe("red\n");
    expect(chunk.lines).toEqual(["red"]);
  });
});
