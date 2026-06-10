export interface ParserReplayFixture {
  agent: "codex";
  chunks: readonly string[];
  expectedTokens: readonly string[];
  expectedToolCalls: readonly {
    kind: "execCommand" | "applyPatch";
    summary: string;
  }[];
  expectedErrors: readonly { message: string; code?: string }[];
}

export const parserReplayFixtures = [
  {
    agent: "codex",
    chunks: [
      "codex\n",
      '{"type":"approvalRequested","approval":{"kind":"applyPatch","summary":"Apply generated parser patch",',
      '"payload":{"file":"packages/parser-sdk/src/index.ts"}}}\n',
      "fatal: model emitted an invalid diff hunk\n",
    ],
    expectedTokens: ["codex\n"],
    expectedToolCalls: [
      { kind: "applyPatch", summary: "Apply generated parser patch" },
    ],
    expectedErrors: [{ message: "fatal: model emitted an invalid diff hunk" }],
  },
] satisfies readonly ParserReplayFixture[];
