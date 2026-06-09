import { describe, expect, it } from "vitest";
import { parseAnsiChunk } from "../ansi.js";
import { OutputParser } from "../output-parser.js";
import { outputParserReplayFixtures } from "./fixtures/output-parser-fixtures.js";

describe("output parsing", () => {
  it("strips ansi escape sequences while preserving raw chunks", () => {
    const chunk = parseAnsiChunk("\u001b[31mred\u001b[0m\n");

    expect(chunk.raw).toContain("\u001b[31m");
    expect(chunk.text).toBe("red\n");
    expect(chunk.lines).toEqual(["red"]);
  });

  it("detects approval and artifact directives from streaming lines", () => {
    const parser = new OutputParser();

    const first = parser.feed(
      'APPROVAL_REQUEST: {"type":"approval","kind":"applyPatch",',
    );
    const second = parser.feed(
      '"summary":"patch file","payload":{"file":"a.ts"}}\nARTIFACT: {"type":"artifact","path":"out.log","kind":"log"}\n',
    );

    expect(first.approvals).toEqual([]);
    expect(second.approvals).toEqual([
      { kind: "applyPatch", summary: "patch file", payload: { file: "a.ts" } },
    ]);
    expect(second.artifacts).toEqual([
      { path: "out.log", kind: "log", mimeType: "application/octet-stream" },
    ]);
  });

  it("extracts readable assistant text from codex json events", () => {
    const parser = new OutputParser("codex-json");

    const first = parser.feed(
      '2026-06-09T04:57:08Z WARN noisy startup\n{"type":"thread.started","thread_id":"t1"}\n',
    );
    const second = parser.feed(
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Projects:\\n- roam-cli"}}\n',
    );

    expect(first.chunk.text).toBe("");
    expect(second.chunk.text).toBe("Projects:\n- roam-cli\n");
  });

  it.each(outputParserReplayFixtures)(
    "replays $agent output fixtures",
    (fixture) => {
      const parser = new OutputParser();
      const results = fixture.chunks.map((chunk) => parser.feed(chunk));

      expect(results.map((result) => result.chunk.text)).toEqual(
        fixture.expectedText,
      );
      expect(results.flatMap((result) => result.approvals)).toEqual(
        fixture.expectedApprovals,
      );
    },
  );
});
