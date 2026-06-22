import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentRuntimeEvent,
  AgentSessionContext,
} from "@roamcli/agent-plugin-sdk";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  type Session,
} from "@roamcli/shared/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: sdk.query,
}));

import { agentPlugin, claudeCodeAgent } from "./index.js";

describe("claude code agent plugin", () => {
  beforeEach(() => {
    sdk.query.mockReset();
  });

  it("builds the default Claude Code capability", () => {
    expect(
      claudeCodeAgent.buildCapability({ profile: "trusted", env: {} }),
    ).toMatchObject({
      kind: "claude-code",
      label: "Claude Code",
      command: "claude",
      args: [],
      parser: "claude-agent-sdk",
      supportsResume: true,
      supportsImages: true,
      supportedImageMimeTypes: [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
      ],
      maxImagesPerTurn: 5,
      maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
      pluginName: "@roamcli/agent-claude-code",
    });
  });

  it("exposes a default plugin with one Claude Code agent", () => {
    expect(
      agentPlugin
        .agents({ profile: "standard", env: {} })
        .map((agent) => agent.kind),
    ).toEqual(["claude-code"]);
  });

  it("maps trusted sessions to SDK bypass permissions and env overrides", async () => {
    sdk.query.mockReturnValue(fakeQuery([]));
    const context = makeContext({
      profile: "trusted",
      env: {
        ROAMCLI_AGENT_CLAUDE_CODE_COMMAND: "local-claude",
        ROAMCLI_AGENT_CLAUDE_CODE_MODEL: "claude-test",
        ROAMCLI_AGENT_CLAUDE_CODE_MAX_TURNS: "7",
      },
      resumeThreadId: "claude-session-1",
    });

    await claudeCodeAgent.createSession(context).start();

    expect(sdk.query).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "hello",
        options: expect.objectContaining({
          cwd: context.cwd,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          pathToClaudeCodeExecutable: "local-claude",
          model: "claude-test",
          maxTurns: 7,
          resume: "claude-session-1",
        }),
      }),
    );
  });

  it("bridges standard-profile SDK tool permissions through RoamCli approvals", async () => {
    sdk.query.mockReturnValue(fakeQuery([]));
    const approvals: unknown[] = [];
    const context = makeContext({
      profile: "standard",
      requestApproval: async (draft) => {
        approvals.push(draft);
        return {
          approved: false,
          signedAt: "2026-06-21T00:00:00.000Z",
          signature: "sig",
        };
      },
    });

    await claudeCodeAgent.createSession(context).start();
    const options = sdk.query.mock.calls[0]?.[0]?.options;
    const result = await options.canUseTool(
      "Bash",
      { command: "pwd" },
      {
        signal: new AbortController().signal,
        title: "Run pwd",
        displayName: "Run shell command",
        description: "Claude wants to run pwd",
        decisionReason: "shell",
        blockedPath: "/tmp/outside",
        toolUseID: "tool-1",
      },
    );

    expect(approvals).toEqual([
      {
        kind: "execCommand",
        summary: "Run pwd",
        payload: {
          toolName: "Bash",
          input: { command: "pwd" },
          displayName: "Run shell command",
          description: "Claude wants to run pwd",
          decisionReason: "shell",
          blockedPath: "/tmp/outside",
          toolUseId: "tool-1",
        },
      },
    ]);
    expect(result).toEqual({
      behavior: "deny",
      message: "Denied by RoamCli approval",
    });
  });

  it("maps SDK session, assistant, and terminal messages to runtime events", async () => {
    const events: AgentRuntimeEvent[] = [];
    sdk.query.mockReturnValue(
      fakeQuery([
        {
          type: "assistant",
          session_id: "claude-session-1",
          message: {
            content: [{ type: "text", text: "Claude response" }],
          },
        },
      ]),
    );

    await claudeCodeAgent
      .createSession(
        makeContext({
          emit: async (event) => {
            events.push(event);
          },
        }),
      )
      .start();

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "thread",
        threadId: "claude-session-1",
      });
      expect(events).toContainEqual({
        type: "message",
        content: "Claude response",
      });
      expect(events).toContainEqual({
        type: "status",
        status: "completed",
      });
    });
  });

  it("passes image attachments through SDK user-message content blocks", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-claude-agent-"));
    const imagePath = join(workspace, "image.png");
    await writeFile(imagePath, "fake image bytes");
    sdk.query.mockReturnValue(fakeQuery([]));

    await claudeCodeAgent
      .createSession(
        makeContext({
          attachments: [
            {
              kind: "image",
              name: "image.png",
              mimeType: "image/png",
              localPath: imagePath,
            },
          ],
        }),
      )
      .start();

    const prompt = sdk.query.mock.calls[0]?.[0]?.prompt as AsyncIterable<SDKUserMessage>;
    const messages: SDKUserMessage[] = [];
    for await (const message of prompt) {
      messages.push(message);
    }

    expect(messages).toEqual([
      {
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            { type: "text", text: "hello" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: Buffer.from("fake image bytes").toString("base64"),
              },
            },
          ],
        },
      },
    ]);
  });
});

function fakeQuery(messages: readonly unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        yield message as SDKMessage;
      }
    },
    close: vi.fn(),
    interrupt: vi.fn(),
    supportedCommands: vi.fn().mockResolvedValue([]),
  };
}

function makeContext(
  overrides: Partial<AgentSessionContext> = {},
): AgentSessionContext {
  return {
    profile: "standard",
    env: {},
    session: makeSession(),
    cwd: "/tmp/workspace",
    prompt: "hello",
    emit: async () => undefined,
    requestApproval: async () => ({
      approved: true,
      signedAt: "2026-06-21T00:00:00.000Z",
      signature: "sig",
    }),
    ...overrides,
  };
}

function makeSession(): Session {
  return {
    id: "s1",
    title: "Session",
    projectId: "project-1",
    runnerId: "r1",
    agent: "claude-code",
    status: "pending",
    executionMode: "direct",
    executionFolder: "/tmp/workspace",
    cwd: "/tmp/workspace",
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
  };
}
