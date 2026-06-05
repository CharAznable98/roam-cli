export interface ParserReplayFixture {
  agent: "claude" | "codex" | "gemini" | "aider";
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
    agent: "claude",
    chunks: [
      "\u001b[36mClaude\u001b[0m is inspecting the workspace.\n",
      '> Bash(pnpm test)\nROAMCLI_APPROVAL {"kind":"execCommand",',
      '"summary":"Run parser tests","payload":{"command":"pnpm --filter @roamcli/parser-sdk test"}}\n',
      "Continuing after approval",
    ],
    expectedTokens: [
      "Claude is inspecting the workspace.\n",
      "> Bash(pnpm test)\n",
      "Continuing after approval\n",
    ],
    expectedToolCalls: [{ kind: "execCommand", summary: "Run parser tests" }],
    expectedErrors: [],
  },
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
  {
    agent: "gemini",
    chunks: [
      "Gemini: checking package scripts.\r\n",
      'APPROVAL_REQUEST: {"type":"approval_request","kind":"execCommand","summary":"List package files",',
      '"payload":{"command":"rg --files packages/parser-sdk"}}\r\n',
      "Result looks usable.\r\n",
    ],
    expectedTokens: [
      "Gemini: checking package scripts.\n",
      "Result looks usable.\n",
    ],
    expectedToolCalls: [{ kind: "execCommand", summary: "List package files" }],
    expectedErrors: [],
  },
  {
    agent: "aider",
    chunks: [
      "Aider v0.82.0\n",
      'ROAMCLI_APPROVAL: {"kind":"applyPatch","summary":"Edit output parser","payload":{"path":"apps/runner/src/output-parser.ts"}}\n',
      "ROAMCLI_APPROVAL {not-json}\n",
      "Done editing.\n",
    ],
    expectedTokens: ["Aider v0.82.0\n", "Done editing.\n"],
    expectedToolCalls: [{ kind: "applyPatch", summary: "Edit output parser" }],
    expectedErrors: [
      {
        message: "Invalid approval marker: {not-json}",
        code: "INVALID_APPROVAL_MARKER",
      },
    ],
  },
] satisfies readonly ParserReplayFixture[];
