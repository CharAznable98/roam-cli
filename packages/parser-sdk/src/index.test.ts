import { describe, expect, it } from "vitest";
import { parserReplayFixtures } from "./__fixtures__/agent-replay-fixtures.js";
import {
  LineParser,
  createDefaultRegistry,
  type AgentParser,
  type ParsedAgentEvent,
} from "./index.js";

describe("parser sdk", () => {
  it("parses line tokens and strips ansi", () => {
    const parser = new LineParser("codex", "codex");
    expect(parser.push("\u001b[32mhello\u001b[0m\n")).toEqual([
      { type: "token", content: "hello\n" },
    ]);
  });

  it("parses approval markers", () => {
    const parser = new LineParser("codex", "codex");
    expect(
      parser.push(
        'ROAMCLI_APPROVAL {"kind":"applyPatch","summary":"Patch"}\n',
      )[0],
    ).toMatchObject({
      type: "toolCall",
      kind: "applyPatch",
      summary: "Patch",
    });
  });

  it("exposes default parser registry", () => {
    expect(createDefaultRegistry().names()).toContain("codex");
  });

  it.each(parserReplayFixtures)(
    "replays $agent transcript fixtures",
    (fixture) => {
      const factory = createDefaultRegistry().get(fixture.agent);
      expect(factory).toBeDefined();

      const events = replay(factory!(), fixture.chunks);

      expect(
        events
          .filter((event) => event.type === "token")
          .map((event) => event.content),
      ).toEqual(fixture.expectedTokens);
      expect(
        events
          .filter((event) => event.type === "toolCall")
          .map(({ kind, summary }) => ({ kind, summary })),
      ).toEqual(fixture.expectedToolCalls);
      expect(
        events
          .filter((event) => event.type === "error")
          .map(({ message, code }) =>
            code === undefined ? { message } : { message, code },
          ),
      ).toEqual(fixture.expectedErrors);
    },
  );
});

function replay(
  parser: AgentParser,
  chunks: readonly string[],
): ParsedAgentEvent[] {
  return [...chunks.flatMap((chunk) => parser.push(chunk)), ...parser.flush()];
}
