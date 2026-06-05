import type { ApprovalRequestDraft } from "../../output-parser.js";

export interface OutputParserReplayFixture {
  agent: "claude" | "codex" | "gemini" | "aider";
  chunks: readonly string[];
  expectedText: readonly string[];
  expectedApprovals: readonly ApprovalRequestDraft[];
}

export const outputParserReplayFixtures = [
  {
    agent: "claude",
    chunks: [
      "\u001b[35mClaude\u001b[0m\n> Bash(pnpm test)\n",
      'APPROVAL_REQUEST: {"type":"approval","kind":"execCommand",',
      '"summary":"Run runner parser tests","payload":{"command":"pnpm --filter @roamcli/runner test"}}\n',
      "error: first run failed\n",
    ],
    expectedText: [
      "Claude\n> Bash(pnpm test)\n",
      'APPROVAL_REQUEST: {"type":"approval","kind":"execCommand",',
      '"summary":"Run runner parser tests","payload":{"command":"pnpm --filter @roamcli/runner test"}}\n',
      "error: first run failed\n",
    ],
    expectedApprovals: [
      {
        kind: "execCommand",
        summary: "Run runner parser tests",
        payload: { command: "pnpm --filter @roamcli/runner test" },
      },
    ],
  },
  {
    agent: "codex",
    chunks: [
      "codex thinking\n",
      '{"type":"approvalRequested","approval":{"kind":"applyPatch","summary":"Apply output parser patch",',
      '"payload":{"file":"apps/runner/src/output-parser.ts"}}}\n',
      "plain token after tool call\n",
    ],
    expectedText: [
      "codex thinking\n",
      '{"type":"approvalRequested","approval":{"kind":"applyPatch","summary":"Apply output parser patch",',
      '"payload":{"file":"apps/runner/src/output-parser.ts"}}}\n',
      "plain token after tool call\n",
    ],
    expectedApprovals: [
      {
        kind: "applyPatch",
        summary: "Apply output parser patch",
        payload: { file: "apps/runner/src/output-parser.ts" },
      },
    ],
  },
  {
    agent: "gemini",
    chunks: [
      "Gemini will inspect files.\r\n",
      'ROAMCLI_APPROVAL: {"type":"approval_request","kind":"execCommand","summary":"List parser files",',
      '"payload":{"command":"rg --files packages/parser-sdk apps/runner/src/output-parser.ts"}}\r\n',
    ],
    expectedText: [
      "Gemini will inspect files.\r\n",
      'ROAMCLI_APPROVAL: {"type":"approval_request","kind":"execCommand","summary":"List parser files",',
      '"payload":{"command":"rg --files packages/parser-sdk apps/runner/src/output-parser.ts"}}\r\n',
    ],
    expectedApprovals: [
      {
        kind: "execCommand",
        summary: "List parser files",
        payload: {
          command:
            "rg --files packages/parser-sdk apps/runner/src/output-parser.ts",
        },
      },
    ],
  },
  {
    agent: "aider",
    chunks: [
      "Aider v0.82.0\n",
      "APPROVAL_REQUEST: {not-json}\n",
      'ROAMCLI_APPROVAL {"kind":"applyPatch","summary":"Edit parser tests","payload":{"path":"apps/runner/src/__tests__"}}\n',
      "Done.\n",
    ],
    expectedText: [
      "Aider v0.82.0\n",
      "APPROVAL_REQUEST: {not-json}\n",
      'ROAMCLI_APPROVAL {"kind":"applyPatch","summary":"Edit parser tests","payload":{"path":"apps/runner/src/__tests__"}}\n',
      "Done.\n",
    ],
    expectedApprovals: [
      {
        kind: "applyPatch",
        summary: "Edit parser tests",
        payload: { path: "apps/runner/src/__tests__" },
      },
    ],
  },
] satisfies readonly OutputParserReplayFixture[];
