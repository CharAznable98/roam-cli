import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
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
          approvalId: "approval-1",
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
        type: "assistantOutput",
        outputId: expect.stringMatching(
          /^claude-run-[^:]+:claude-output-1$/,
        ),
        content: "Claude response",
        mode: "replace",
        done: true,
      });
      expect(events).toContainEqual({
        type: "status",
        status: "completed",
      });
    });
  });

  it("maps SDK system task messages to activity instead of assistant messages", async () => {
    const events: AgentRuntimeEvent[] = [];
    sdk.query.mockReturnValue(
      fakeQuery([
        {
          type: "system",
          subtype: "status",
          status: "requesting",
        },
        {
          type: "system",
          subtype: "task_started",
          description: "Explore file preview component",
        },
        {
          type: "system",
          subtype: "task_progress",
          description: "Running List root directory contents",
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
      expect(events.filter((event) => event.type === "activity")).toHaveLength(
        3,
      );
    });
    expect(events.filter((event) => event.type === "activity")).toEqual([
      {
        type: "activity",
        kind: "status",
        label: "Requesting",
      },
      {
        type: "activity",
        kind: "task_started",
        label: "Exploring file preview component",
      },
      {
        type: "activity",
        kind: "task_progress",
        label: "Listing root directory contents",
      },
    ]);
    expect(
      events.some(
        (event) =>
          event.type === "assistantOutput" &&
          (event.content ?? "").startsWith("Claude Code task"),
      ),
    ).toBe(false);
  });

  it("queues active user messages for the next resumed SDK query", async () => {
    const events: AgentRuntimeEvent[] = [];
    const firstQuery = deferredQuery([
      {
        type: "assistant",
        session_id: "claude-session-1",
        message: {
          content: [{ type: "text", text: "First response" }],
        },
      },
    ]);
    sdk.query.mockReturnValueOnce(firstQuery.query).mockReturnValueOnce(
      fakeQuery([
        {
          type: "assistant",
          session_id: "claude-session-1",
          message: {
            content: [{ type: "text", text: "Follow-up response" }],
          },
        },
      ]),
    );
    const session = claudeCodeAgent.createSession(
      makeContext({
        emit: async (event) => {
          events.push(event);
        },
      }),
    );

    await session.start();
    expect(sdk.query).toHaveBeenCalledTimes(1);
    session.deliverInput({ content: "follow up" });
    expect(sdk.query).toHaveBeenCalledTimes(1);
    firstQuery.release();

    await vi.waitFor(() => {
      expect(sdk.query).toHaveBeenCalledTimes(2);
    });
    expect(sdk.query.mock.calls[1]?.[0]).toMatchObject({
      prompt: "follow up",
      options: expect.objectContaining({
        resume: "claude-session-1",
      }),
    });
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "assistantOutput",
        content: "Follow-up response",
        mode: "replace",
        done: true,
        outputId: expect.stringMatching(
          /^claude-run-[^:]+:claude-output-2$/,
        ),
      });
      expect(
        events.filter(
          (event) => event.type === "status" && event.status === "completed",
        ),
      ).toHaveLength(1);
    });
  });

  it("does not resume from thread ids that failed to emit", async () => {
    const firstQuery = deferredQuery([
      {
        type: "assistant",
        session_id: "claude-session-1",
        message: {
          content: [{ type: "text", text: "First response" }],
        },
      },
    ]);
    sdk.query
      .mockReturnValueOnce(firstQuery.query)
      .mockReturnValueOnce(fakeQuery([]));
    const session = claudeCodeAgent.createSession(
      makeContext({
        emit: async (event) => {
          if (event.type === "thread") {
            throw new Error("sink down");
          }
        },
      }),
    );

    await session.start();
    session.deliverInput({ content: "follow up" });
    firstQuery.release();

    await vi.waitFor(() => {
      expect(sdk.query).toHaveBeenCalledTimes(2);
    });
    expect(sdk.query.mock.calls[1]?.[0]).toMatchObject({
      prompt: "follow up",
    });
    expect(sdk.query.mock.calls[1]?.[0]?.options).not.toHaveProperty("resume");
  });

  it("keeps stopped status when the SDK iterator rejects after stop", async () => {
    const events: AgentRuntimeEvent[] = [];
    const abortedQuery = deferredThrowingQuery(new Error("aborted"));
    sdk.query.mockReturnValue(abortedQuery.query);
    const session = claudeCodeAgent.createSession(
      makeContext({
        emit: async (event) => {
          events.push(event);
        },
      }),
    );

    await session.start();
    await session.control("stop");
    abortedQuery.release();

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "status",
        status: "stopped",
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events).not.toContainEqual({ type: "status", status: "failed" });
  });

  it("does not convert event sink failures into Claude failures", async () => {
    const events: AgentRuntimeEvent[] = [];
    sdk.query.mockReturnValue(fakeQuery([]));

    await claudeCodeAgent
      .createSession(
        makeContext({
          emit: async (event) => {
            events.push(event);
            if (event.type === "status" && event.status === "completed") {
              throw new Error("sink down");
            }
          },
        }),
      )
      .start();

    await vi.waitFor(() => {
      expect(events).toContainEqual({ type: "status", status: "completed" });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events).not.toContainEqual({ type: "status", status: "failed" });
  });

  it("does not emit a duplicate final assistant message after stream tokens", async () => {
    const events: AgentRuntimeEvent[] = [];
    sdk.query.mockReturnValue(
      fakeQuery([
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Claude response" },
          },
        },
        {
          type: "assistant",
          message: {
            id: "msg_final",
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
        type: "assistantOutput",
        outputId: expect.stringMatching(
          /^claude-run-[^:]+:claude-output-1$/,
        ),
        content: "Claude response",
        mode: "append",
        done: false,
      });
      expect(events).toContainEqual({
        type: "status",
        status: "completed",
      });
    });
    expect(
      events.filter((event) => event.type === "assistantOutput"),
    ).toEqual([
      {
        type: "assistantOutput",
        outputId: expect.stringMatching(
          /^claude-run-[^:]+:claude-output-1$/,
        ),
        content: "Claude response",
        mode: "append",
        done: false,
      },
      {
        type: "assistantOutput",
        outputId: expect.stringMatching(
          /^claude-run-[^:]+:claude-output-1$/,
        ),
        content: "Claude response",
        mode: "replace",
        done: true,
      },
    ]);
  });

  it("emits final assistant output when stream token delivery fails", async () => {
    const events: AgentRuntimeEvent[] = [];
    sdk.query.mockReturnValue(
      fakeQuery([
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Claude response" },
          },
        },
        {
          type: "assistant",
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
            if (
              event.type === "assistantOutput" &&
              event.mode === "append"
            ) {
              throw new Error("sink down");
            }
            events.push(event);
          },
        }),
      )
      .start();

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "assistantOutput",
        outputId: expect.stringMatching(
          /^claude-run-[^:]+:claude-output-1$/,
        ),
        content: "Claude response",
        mode: "replace",
        done: true,
      });
      expect(events).toContainEqual({
        type: "status",
        status: "completed",
      });
    });
    expect(events).not.toContainEqual({
      type: "assistantOutput",
      content: "Claude response",
      mode: "append",
      done: false,
    });
  });

  it("scopes fallback output ids across session instances", async () => {
    const events: AgentRuntimeEvent[] = [];
    const assistantMessage = (text: string) => ({
      type: "assistant",
      message: {
        content: [{ type: "text", text }],
      },
    });
    sdk.query
      .mockReturnValueOnce(fakeQuery([assistantMessage("First")]))
      .mockReturnValueOnce(fakeQuery([assistantMessage("Second")]));

    await claudeCodeAgent
      .createSession(
        makeContext({
          emit: async (event) => {
            events.push(event);
          },
        }),
      )
      .start();
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
      expect(
        events.filter((event) => event.type === "assistantOutput"),
      ).toHaveLength(2);
    });

    const outputIds = events
      .filter((event) => event.type === "assistantOutput")
      .map((event) => event.outputId);
    expect(outputIds[0]).toMatch(/^claude-run-[^:]+:claude-output-1$/);
    expect(outputIds[1]).toMatch(/^claude-run-[^:]+:claude-output-1$/);
    expect(outputIds[0]).not.toBe(outputIds[1]);
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

    const prompt = sdk.query.mock.calls[0]?.[0]
      ?.prompt as AsyncIterable<SDKUserMessage>;
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

  it("lists Claude Code skills with workspace scoping and command overrides", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-claude-skills-"));
    const basePath = join(workspace, "project");
    await mkdir(basePath, { recursive: true });
    const realBasePath = await realpath(basePath);
    sdk.query.mockReturnValue(
      fakeQuery([], [{ name: "/plan", description: "Local plan" }]),
    );

    const skills = await claudeCodeAgent.listSkills?.({
      profile: "standard",
      env: { ROAMCLI_AGENT_CLAUDE_CODE_COMMAND: "local-claude" },
      workspace,
      basePath,
    });

    expect(sdk.query).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: " ",
        options: expect.objectContaining({
          cwd: realBasePath,
          pathToClaudeCodeExecutable: "local-claude",
        }),
      }),
    );
    expect(skills).toEqual([
      {
        name: "plan",
        description: "Local plan",
        insertText: "/plan",
        sourceType: "project",
        sourcePath: realBasePath,
      },
    ]);
  });

  it("does not list Claude Code skills outside the workspace", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-claude-skills-workspace-"),
    );
    const outside = await mkdtemp(
      join(tmpdir(), "roam-claude-skills-outside-"),
    );

    await expect(
      claudeCodeAgent.listSkills?.({
        profile: "standard",
        env: {},
        workspace,
        basePath: outside,
      }),
    ).resolves.toEqual([]);
    expect(sdk.query).not.toHaveBeenCalled();
  });
});

function fakeQuery(
  messages: readonly unknown[],
  supportedCommands: readonly { name: string; description?: string }[] = [],
) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        yield message as SDKMessage;
      }
    },
    close: vi.fn(),
    interrupt: vi.fn(),
    supportedCommands: vi.fn().mockResolvedValue(supportedCommands),
  };
}

function deferredQuery(messages: readonly unknown[]) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    query: {
      async *[Symbol.asyncIterator]() {
        await released;
        for (const message of messages) {
          yield message as SDKMessage;
        }
      },
      close: vi.fn(),
      interrupt: vi.fn(),
      supportedCommands: vi.fn().mockResolvedValue([]),
    },
  };
}

function deferredThrowingQuery(error: unknown) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    query: {
      async *[Symbol.asyncIterator]() {
        await released;
        throw error;
      },
      close: vi.fn(),
      interrupt: vi.fn(),
      supportedCommands: vi.fn().mockResolvedValue([]),
    },
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
      approvalId: "approval-1",
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
