import { describe, expect, it } from "vitest";
import { streamingDisplayText } from "./directives.js";

describe("streamingDisplayText", () => {
  it("streams ordinary text while holding directive prefixes", () => {
    expect(streamingDisplayText("Visible answer\nROAMCLI_AP")).toBe(
      "Visible answer\n",
    );
  });

  it.each([
    'APPROVAL_REQUEST: {"kind":"execCommand","summary":"Run"}',
    'ROAMCLI_APPROVAL: {"kind":"execCommand","summary":"Run"}',
    'ARTIFACT: {"type":"artifact","path":"report.md"}',
    'ROAMCLI_ARTIFACT: {"type":"artifact","path":"report.md"}',
    '{"type":"approval","kind":"execCommand","summary":"Run"}',
    '{"type":"artifact","path":"report.md"}',
  ])("never exposes a complete directive line: %s", (directive) => {
    expect(streamingDisplayText(`Before\n${directive}`)).toBe("Before\n");
    expect(streamingDisplayText(`Before\n${directive}\nAfter`)).toBe(
      "Before\nAfter",
    );
  });

  it("releases malformed directive-like text after its line completes", () => {
    expect(streamingDisplayText("ROAMCLI_APPROVAL: not-json")).toBe("");
    expect(streamingDisplayText("ROAMCLI_APPROVAL: not-json\nNext")).toBe(
      "ROAMCLI_APPROVAL: not-json\nNext",
    );
  });
});
