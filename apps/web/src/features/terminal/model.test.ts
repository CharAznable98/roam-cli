import { describe, expect, it } from "vitest";
import { appendTerminalChunk, stripAnsi } from "./model";

describe("terminal model", () => {
  it("strips ANSI escapes from terminal chunks", () => {
    expect(stripAnsi("\u001b[31mfailed\u001b[0m")).toBe("failed");
  });

  it("caps terminal history at the configured line count", () => {
    expect(appendTerminalChunk(["one", "two"], "three", 2)).toEqual([
      "two",
      "three",
    ]);
  });
});
