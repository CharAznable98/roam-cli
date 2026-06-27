import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentRuntimeEvent,
  AgentSessionContext,
} from "@roamcli/agent-plugin-sdk";
import { DEFAULT_MAX_IMAGE_BYTES } from "@roamcli/shared/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  CodexJsonParser,
  agentPlugin,
  approvalResponsePayload,
  codexAgent,
  codexJsonArgs,
  listCodexSkills,
  parseArgs,
} from "./index.js";

const execFileAsync = promisify(execFile);

describe("codex agent plugin", () => {
  it("builds the default codex capability", () => {
    expect(
      codexAgent.buildCapability({ profile: "trusted", env: {} }),
    ).toMatchObject({
      kind: "codex",
      label: "Codex",
      command: "codex",
      args: ["app-server", "--stdio", "-c", "skip_git_repo_check=true"],
      parser: "codex-app-server",
      supportsResume: true,
      supportsImages: true,
      supportedImageMimeTypes: ["image/png", "image/jpeg"],
      maxImagesPerTurn: 5,
      maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
      pluginName: "@roamcli/agent-codex",
    });
  });

  it("builds the legacy codex exec capability when explicitly selected", () => {
    expect(
      codexAgent.buildCapability({
        profile: "trusted",
        env: { ROAMCLI_AGENT_CODEX_MODE: "exec-json" },
      }),
    ).toMatchObject({
      kind: "codex",
      label: "Codex",
      command: "codex",
      args: [
        "exec",
        "--json",
        "--color",
        "never",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
      ],
      parser: "codex-json",
      supportsResume: true,
      supportsImages: true,
      supportedImageMimeTypes: ["image/png", "image/jpeg"],
      maxImagesPerTurn: 5,
      maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
      pluginName: "@roamcli/agent-codex",
    });
  });

  it("exposes a default plugin with one codex agent", () => {
    expect(
      agentPlugin
        .agents({ profile: "standard", env: {} })
        .map((agent) => agent.kind),
    ).toEqual(["codex"]);
  });

  it("builds codex json resume args with the stored thread id and prompt argument", () => {
    expect(
      codexJsonArgs(
        [
          "exec",
          "--json",
          "--color",
          "never",
          "--skip-git-repo-check",
          "--dangerously-bypass-approvals-and-sandbox",
        ],
        "next prompt",
        "thread-1",
      ),
    ).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "thread-1",
      "next prompt",
    ]);
  });

  it("passes image paths to codex exec and resume invocations", () => {
    expect(
      codexJsonArgs(["exec", "--json"], "describe image", undefined, [
        "/tmp/a.png",
        "/tmp/b.jpg",
      ]),
    ).toEqual([
      "exec",
      "--json",
      "describe image",
      "--image",
      "/tmp/a.png",
      "--image",
      "/tmp/b.jpg",
    ]);

    expect(
      codexJsonArgs(
        ["exec", "--json", "--color", "never"],
        "resume image",
        "thread-1",
        ["/tmp/a.png"],
      ),
    ).toEqual([
      "exec",
      "resume",
      "--json",
      "thread-1",
      "resume image",
      "--image",
      "/tmp/a.png",
    ]);
  });

  it("extracts complete assistant messages from codex json events", () => {
    const parser = new CodexJsonParser();

    const result = parser.feed(
      [
        '{"type":"thread.started","thread_id":"codex-thread-1"}',
        '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Projects:\\n- roam-cli"}}',
        "",
      ].join("\n"),
    );

    expect(result.threadId).toBe("codex-thread-1");
    expect(result.assistantOutputs).toEqual([
      {
        type: "assistantOutput",
        outputId: expect.stringMatching(/^codex-run-[^:]+:item_1$/),
        content: "Projects:\n- roam-cli",
        mode: "replace",
        done: true,
      },
    ]);
  });

  it("keeps multiple completed codex messages separated", () => {
    const parser = new CodexJsonParser();

    const result = parser.feed(
      [
        '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"first"}}',
        '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"second"}}',
        "",
      ].join("\n"),
    );

    expect(result.assistantOutputs).toEqual([
      {
        type: "assistantOutput",
        outputId: expect.stringMatching(/^codex-run-[^:]+:item_1$/),
        content: "first",
        mode: "replace",
        done: true,
      },
      {
        type: "assistantOutput",
        outputId: expect.stringMatching(/^codex-run-[^:]+:item_2$/),
        content: "second",
        mode: "replace",
        done: true,
      },
    ]);
  });

  it("scopes codex item ids per parser run", () => {
    const first = new CodexJsonParser();
    const second = new CodexJsonParser();
    const payload =
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"answer"}}\n';

    const firstOutputId = first.feed(payload).assistantOutputs?.[0]?.outputId;
    const secondOutputId = second.feed(payload).assistantOutputs?.[0]?.outputId;

    expect(firstOutputId).toMatch(/^codex-run-[^:]+:item_1$/);
    expect(secondOutputId).toMatch(/^codex-run-[^:]+:item_1$/);
    expect(firstOutputId).not.toBe(secondOutputId);
  });

  it("extracts approval directives from codex assistant text", () => {
    const parser = new CodexJsonParser();

    const result = parser.feed(
      `${JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "agent_message",
          text: 'ROAMCLI_APPROVAL: {"type":"approval_request","kind":"execCommand","summary":"Run tests","payload":{"command":"pnpm test"}}',
        },
      })}\n`,
    );

    expect(result.approvals).toEqual([
      {
        kind: "execCommand",
        summary: "Run tests",
        payload: { command: "pnpm test" },
      },
    ]);
  });

  it("includes approval IDs in subprocess approval response payloads", () => {
    expect(
      approvalResponsePayload({
        approvalId: "approval-1",
        approved: true,
        signedAt: "2026-06-21T00:00:00.000Z",
        signature: "signature",
      }),
    ).toEqual({
      type: "approvalResponse",
      approvalId: "approval-1",
      approved: true,
      signedAt: "2026-06-21T00:00:00.000Z",
      signature: "signature",
    });
  });

  it("fails sessions cleanly when approval requests cannot be created", async () => {
    const workspace = await mkdirTemp("roam-codex-approval-failure-");
    const script = join(workspace, "approval-failure.mjs");
    await writeFile(
      script,
      [
        "console.log(JSON.stringify({",
        "  type: 'item.completed',",
        "  item: {",
        "    id: 'item_1',",
        "    type: 'agent_message',",
        "    text: 'ROAMCLI_APPROVAL: {\"type\":\"approval_request\",\"kind\":\"execCommand\",\"summary\":\"Run tests\",\"payload\":{\"command\":\"pnpm test\"}}',",
        "  },",
        "}));",
        "setInterval(() => undefined, 1000);",
      ].join("\n"),
    );
    const events: AgentRuntimeEvent[] = [];
    const session = codexAgent.createSession({
      profile: "standard",
      env: {
        ROAMCLI_AGENT_CODEX_MODE: "exec-json",
        ROAMCLI_AGENT_CODEX_COMMAND: process.execPath,
        ROAMCLI_AGENT_CODEX_ARGS: JSON.stringify([script]),
      },
      session: makeSession(workspace),
      cwd: workspace,
      prompt: "hello",
      emit: async (event) => {
        events.push(event);
      },
      requestApproval: async () => {
        throw new Error("approval store down");
      },
    });

    await session.start();

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "error",
        message: "approval store down",
        code: "CODEX_APPROVAL_ERROR",
      });
      expect(events).toContainEqual({ type: "status", status: "failed" });
    });
  });

  it("waits for approval failures before choosing process exit status", async () => {
    const workspace = await mkdirTemp("roam-codex-approval-exit-");
    const script = join(workspace, "approval-exit.mjs");
    await writeFile(
      script,
      [
        "console.log(JSON.stringify({",
        "  type: 'item.completed',",
        "  item: {",
        "    id: 'item_1',",
        "    type: 'agent_message',",
        "    text: 'ROAMCLI_APPROVAL: {\"type\":\"approval_request\",\"kind\":\"execCommand\",\"summary\":\"Run tests\",\"payload\":{\"command\":\"pnpm test\"}}',",
        "  },",
        "}));",
      ].join("\n"),
    );
    const events: AgentRuntimeEvent[] = [];
    const session = codexAgent.createSession({
      profile: "standard",
      env: {
        ROAMCLI_AGENT_CODEX_MODE: "exec-json",
        ROAMCLI_AGENT_CODEX_COMMAND: process.execPath,
        ROAMCLI_AGENT_CODEX_ARGS: JSON.stringify([script]),
      },
      session: makeSession(workspace),
      cwd: workspace,
      prompt: "hello",
      emit: async (event) => {
        events.push(event);
      },
      requestApproval: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        throw new Error("approval store down");
      },
    });

    await session.start();

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "error",
        message: "approval store down",
        code: "CODEX_APPROVAL_ERROR",
      });
      expect(events).toContainEqual({ type: "status", status: "failed" });
    });
    expect(events).not.toContainEqual({ type: "status", status: "completed" });
  });

  it("does not block stopped sessions on pending approvals", async () => {
    const workspace = await mkdirTemp("roam-codex-stop-approval-");
    const script = join(workspace, "stop-approval.mjs");
    await writeFile(
      script,
      [
        "console.log(JSON.stringify({",
        "  type: 'item.completed',",
        "  item: {",
        "    id: 'item_1',",
        "    type: 'agent_message',",
        "    text: 'ROAMCLI_APPROVAL: {\"type\":\"approval_request\",\"kind\":\"execCommand\",\"summary\":\"Run tests\",\"payload\":{\"command\":\"pnpm test\"}}',",
        "  },",
        "}));",
        "setInterval(() => undefined, 1000);",
      ].join("\n"),
    );
    let approvalStarted!: () => void;
    const approvalStartedPromise = new Promise<void>((resolve) => {
      approvalStarted = resolve;
    });
    const events: AgentRuntimeEvent[] = [];
    const session = codexAgent.createSession({
      profile: "standard",
      env: {
        ROAMCLI_AGENT_CODEX_MODE: "exec-json",
        ROAMCLI_AGENT_CODEX_COMMAND: process.execPath,
        ROAMCLI_AGENT_CODEX_ARGS: JSON.stringify([script]),
      },
      session: makeSession(workspace),
      cwd: workspace,
      prompt: "hello",
      emit: async (event) => {
        events.push(event);
      },
      requestApproval: async () => {
        approvalStarted();
        return new Promise<never>(() => undefined);
      },
    });

    await session.start();
    await approvalStartedPromise;
    session.control("stop");

    await vi.waitFor(() => {
      expect(events).toContainEqual({ type: "status", status: "stopped" });
    });
    expect(events).not.toContainEqual({ type: "status", status: "failed" });
  });

  it("handles terminal status emit failures without unhandled rejections", async () => {
    const workspace = await mkdirTemp("roam-codex-finish-reject-");
    const script = join(workspace, "finish-reject.mjs");
    await writeFile(script, "process.exit(0);");
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const session = codexAgent.createSession({
        profile: "standard",
        env: {
          ROAMCLI_AGENT_CODEX_MODE: "exec-json",
          ROAMCLI_AGENT_CODEX_COMMAND: process.execPath,
          ROAMCLI_AGENT_CODEX_ARGS: JSON.stringify([script]),
        },
        session: makeSession(workspace),
        cwd: workspace,
        prompt: "hello",
        emit: async (event) => {
          if (event.type === "status") {
            throw new Error("sink down");
          }
        },
        requestApproval: async () => ({
          approvalId: "approval-1",
          approved: true,
          signedAt: "2026-06-21T00:00:00.000Z",
          signature: "sig",
        }),
      });

      await session.start();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("closes stdin for bypass sessions so codex does not wait for extra stdin", async () => {
    const workspace = await mkdirTemp("roam-codex-bypass-stdin-");
    const script = join(workspace, "bypass-stdin.mjs");
    await writeFile(
      script,
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  console.log(JSON.stringify({",
        "    type: 'item.completed',",
        "    item: {",
        "      id: 'item_1',",
        "      type: 'agent_message',",
        "      text: 'stdin closed',",
        "    },",
        "  }));",
        "  process.exit(0);",
        "});",
        "setTimeout(() => process.exit(2), 1000);",
      ].join("\n"),
    );
    const events: AgentRuntimeEvent[] = [];
    const session = codexAgent.createSession({
      profile: "standard",
      env: {
        ROAMCLI_AGENT_CODEX_MODE: "exec-json",
        ROAMCLI_AGENT_CODEX_COMMAND: process.execPath,
        ROAMCLI_AGENT_CODEX_ARGS: JSON.stringify([
          script,
          "--dangerously-bypass-approvals-and-sandbox",
        ]),
      },
      session: makeSession(workspace),
      cwd: workspace,
      prompt: "hello",
      emit: async (event) => {
        events.push(event);
      },
      requestApproval: async () => ({
        approvalId: "approval-1",
        approved: true,
        signedAt: "2026-06-21T00:00:00.000Z",
        signature: "sig",
      }),
    });

    await session.start();

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "assistantOutput",
        outputId: expect.stringMatching(/^codex-run-[^:]+:item_1$/),
        content: "stdin closed",
        mode: "replace",
        done: true,
      });
      expect(events).toContainEqual({ type: "status", status: "completed" });
    });
  });

  it("keeps stdin open for subprocess approval responses", async () => {
    const workspace = await mkdirTemp("roam-codex-approval-stdin-");
    const script = join(workspace, "approval-stdin.mjs");
    await writeFile(
      script,
      [
        "console.log(JSON.stringify({",
        "  type: 'item.completed',",
        "  item: {",
        "    id: 'item_1',",
        "    type: 'agent_message',",
        "    text: 'ROAMCLI_APPROVAL: {\"type\":\"approval_request\",\"kind\":\"execCommand\",\"summary\":\"Run tests\",\"payload\":{\"command\":\"pnpm test\"}}',",
        "  },",
        "}));",
        "process.stdin.setEncoding('utf8');",
        "let buffer = '';",
        "process.stdin.on('data', (chunk) => {",
        "  buffer += chunk;",
        "  const lines = buffer.split(/\\r?\\n/);",
        "  buffer = lines.pop() ?? '';",
        "  for (const line of lines) {",
        "    if (!line) continue;",
        "    const payload = JSON.parse(line);",
        "    if (payload.type === 'approvalResponse') {",
        "      console.log(JSON.stringify({",
        "        type: 'item.completed',",
        "        item: {",
        "          id: 'item_2',",
        "          type: 'agent_message',",
        "          text: `approval response: ${payload.approvalId}:${payload.approved}`,",
        "        },",
        "      }));",
        "      process.exit(0);",
        "    }",
        "  }",
        "});",
      ].join("\n"),
    );
    const events: AgentRuntimeEvent[] = [];
    const session = codexAgent.createSession({
      profile: "standard",
      env: {
        ROAMCLI_AGENT_CODEX_MODE: "exec-json",
        ROAMCLI_AGENT_CODEX_COMMAND: process.execPath,
        ROAMCLI_AGENT_CODEX_ARGS: JSON.stringify([script]),
      },
      session: makeSession(workspace),
      cwd: workspace,
      prompt: "hello",
      emit: async (event) => {
        events.push(event);
      },
      requestApproval: async () => ({
        approvalId: "approval-1",
        approved: true,
        signedAt: "2026-06-21T00:00:00.000Z",
        signature: "sig",
      }),
    });

    await session.start();

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "assistantOutput",
        outputId: expect.stringMatching(/^codex-run-[^:]+:item_2$/),
        content: "approval response: approval-1:true",
        mode: "replace",
        done: true,
      });
      expect(events).toContainEqual({ type: "status", status: "completed" });
    });
  });

  it("completes app-server turns when start response and completion share a chunk", async () => {
    const workspace = await mkdirTemp("roam-codex-app-server-coalesced-");
    const closedMarker = join(workspace, "closed.txt");
    await writeAppServerScript(
      workspace,
      "coalesced.mjs",
      [
        `const closedMarker = ${JSON.stringify(closedMarker)};`,
        "process.on('SIGTERM', () => { fs.writeFileSync(closedMarker, 'closed'); process.exit(0); });",
        "handleMessage = (message) => {",
        "  if (message.method === 'initialize') write({ id: message.id, result: {} });",
        "  if (message.method === 'thread/start') write({ id: message.id, result: { thread: { id: 'thread-1' } } });",
        "  if (message.method === 'turn/start') {",
        "    write({ id: message.id, result: { turn: { id: 'turn-1' } } });",
        "    write({ method: 'item/completed', params: { item: { id: 'item-1', type: 'agentMessage', text: 'coalesced done' } } });",
        "    write({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });",
        "  }",
        "};",
        "setInterval(() => undefined, 1000);",
      ],
    );
    const events: AgentRuntimeEvent[] = [];
    const session = codexAgent.createSession({
      profile: "standard",
      env: {
        ROAMCLI_AGENT_CODEX_COMMAND: process.execPath,
      },
      session: makeSession(workspace),
      cwd: workspace,
      prompt: "hello",
      emit: async (event) => {
        events.push(event);
      },
      requestApproval: async () => ({
        approvalId: "approval-1",
        approved: true,
        signedAt: "2026-06-21T00:00:00.000Z",
        signature: "sig",
      }),
    });

    await session.start();

    await vi.waitFor(async () => {
      expect(events).toContainEqual({
        type: "assistantOutput",
        outputId: expect.stringMatching(/^codex-app-server-run-[^:]+-1:item-1$/),
        content: "coalesced done",
        mode: "replace",
        done: true,
      });
      expect(events).toContainEqual({ type: "status", status: "completed" });
      await expect(readFile(closedMarker, "utf8")).resolves.toBe("closed");
    });
  });

  it("closes app-server when thread startup fails", async () => {
    const workspace = await mkdirTemp("roam-codex-app-server-startup-fail-");
    const closedMarker = join(workspace, "closed.txt");
    await writeAppServerScript(
      workspace,
      "startup-fail.mjs",
      [
        `const closedMarker = ${JSON.stringify(closedMarker)};`,
        "process.on('SIGTERM', () => { fs.writeFileSync(closedMarker, 'closed'); process.exit(0); });",
        "handleMessage = (message) => {",
        "  if (message.method === 'initialize') write({ id: message.id, result: {} });",
        "  if (message.method === 'thread/start') write({ id: message.id, error: { code: -32000, message: 'thread missing' } });",
        "};",
        "setInterval(() => undefined, 1000);",
      ],
    );
    const session = codexAgent.createSession({
      profile: "standard",
      env: {
        ROAMCLI_AGENT_CODEX_COMMAND: process.execPath,
      },
      session: makeSession(workspace),
      cwd: workspace,
      prompt: "hello",
      emit: async () => undefined,
      requestApproval: async () => ({
        approvalId: "approval-1",
        approved: true,
        signedAt: "2026-06-21T00:00:00.000Z",
        signature: "sig",
      }),
    });

    await expect(session.start()).rejects.toThrow(
      /Codex app-server thread\/start failed/,
    );
    await vi.waitFor(async () => {
      await expect(readFile(closedMarker, "utf8")).resolves.toBe("closed");
    });
  });

  it("preserves stopped status when app-server startup is cancelled", async () => {
    const workspace = await mkdirTemp("roam-codex-app-server-startup-stop-");
    const initializedMarker = join(workspace, "initialized.txt");
    await writeAppServerScript(
      workspace,
      "startup-stop.mjs",
      [
        `const initializedMarker = ${JSON.stringify(initializedMarker)};`,
        "handleMessage = (message) => {",
        "  if (message.method === 'initialize') fs.writeFileSync(initializedMarker, 'initialized');",
        "};",
        "setInterval(() => undefined, 1000);",
      ],
    );
    const events: AgentRuntimeEvent[] = [];
    const session = codexAgent.createSession({
      profile: "standard",
      env: {
        ROAMCLI_AGENT_CODEX_COMMAND: process.execPath,
      },
      session: makeSession(workspace),
      cwd: workspace,
      prompt: "hello",
      emit: async (event) => {
        events.push(event);
      },
      requestApproval: async () => ({
        approvalId: "approval-1",
        approved: true,
        signedAt: "2026-06-21T00:00:00.000Z",
        signature: "sig",
      }),
    });

    const startPromise = session.start();
    await vi.waitFor(async () => {
      await expect(readFile(initializedMarker, "utf8")).resolves.toBe(
        "initialized",
      );
    });
    await session.control("stop");

    await expect(startPromise).resolves.toBeUndefined();
    expect(events).toContainEqual({ type: "status", status: "stopped" });
    expect(events).not.toContainEqual({ type: "status", status: "failed" });
  });

  it("passes trusted runner permissions to app-server turns", async () => {
    const workspace = await mkdirTemp("roam-codex-app-server-profile-");
    const capturedPath = join(workspace, "captured.jsonl");
    await writeAppServerScript(
      workspace,
      "profile.mjs",
      [
        `const capturedPath = ${JSON.stringify(capturedPath)};`,
        "function capture(message) { fs.appendFileSync(capturedPath, `${JSON.stringify(message)}\\n`); }",
        "handleMessage = (message) => {",
        "  if (message.method === 'initialize') {",
        "    capture(message);",
        "    write({ id: message.id, result: {} });",
        "  }",
        "  if (message.method === 'thread/start') {",
        "    capture(message);",
        "    write({ id: message.id, result: { thread: { id: 'thread-1' } } });",
        "  }",
        "  if (message.method === 'turn/start') {",
        "    capture(message);",
        "    write({ id: message.id, result: { turn: { id: 'turn-1' } } });",
        "    write({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });",
        "  }",
        "};",
      ],
    );
    const session = codexAgent.createSession({
      profile: "trusted",
      env: {
        ROAMCLI_AGENT_CODEX_COMMAND: process.execPath,
      },
      session: makeSession(workspace),
      cwd: workspace,
      prompt: "hello",
      emit: async () => undefined,
      requestApproval: async () => ({
        approvalId: "approval-1",
        approved: true,
        signedAt: "2026-06-21T00:00:00.000Z",
        signature: "sig",
      }),
    });

    await session.start();

    await vi.waitFor(async () => {
      const messages = (await readFile(capturedPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(messages).toEqual([
        expect.objectContaining({
          method: "initialize",
          params: expect.objectContaining({
            capabilities: { experimentalApi: true },
          }),
        }),
        expect.objectContaining({
          method: "thread/start",
          params: expect.objectContaining({
            approvalPolicy: "never",
            sandbox: "danger-full-access",
          }),
        }),
        expect.objectContaining({
          method: "turn/start",
          params: expect.objectContaining({
            approvalPolicy: "never",
            sandboxPolicy: { type: "dangerFullAccess" },
          }),
        }),
      ]);
    });
  });

  it("maps app-server interrupted turns to stopped status", async () => {
    const workspace = await mkdirTemp("roam-codex-app-server-interrupt-");
    const startedMarker = join(workspace, "started.txt");
    await writeAppServerScript(
      workspace,
      "interrupt.mjs",
      [
        `const startedMarker = ${JSON.stringify(startedMarker)};`,
        "handleMessage = (message) => {",
        "  if (message.method === 'initialize') write({ id: message.id, result: {} });",
        "  if (message.method === 'thread/start') write({ id: message.id, result: { thread: { id: 'thread-1' } } });",
        "  if (message.method === 'turn/start') {",
        "    fs.writeFileSync(startedMarker, 'started');",
        "    write({ id: message.id, result: { turn: { id: 'turn-1' } } });",
        "  }",
        "  if (message.method === 'turn/interrupt') {",
        "    write({ id: message.id, result: {} });",
        "    write({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'interrupted' } } });",
        "  }",
        "};",
        "setInterval(() => undefined, 1000);",
      ],
    );
    const events: AgentRuntimeEvent[] = [];
    const session = codexAgent.createSession({
      profile: "standard",
      env: {
        ROAMCLI_AGENT_CODEX_COMMAND: process.execPath,
      },
      session: makeSession(workspace),
      cwd: workspace,
      prompt: "hello",
      emit: async (event) => {
        events.push(event);
      },
      requestApproval: async () => ({
        approvalId: "approval-1",
        approved: true,
        signedAt: "2026-06-21T00:00:00.000Z",
        signature: "sig",
      }),
    });

    await session.start();
    await vi.waitFor(async () => {
      await expect(readFile(startedMarker, "utf8")).resolves.toBe("started");
    });
    await session.control("interrupt");

    await vi.waitFor(() => {
      expect(events).toContainEqual({ type: "status", status: "stopped" });
    });
    expect(events).not.toContainEqual({ type: "status", status: "completed" });
  });

  it("does not block app-server interrupts behind pending approval prompts", async () => {
    const workspace = await mkdirTemp("roam-codex-app-server-approval-interrupt-");
    const approvalMarker = join(workspace, "approval.txt");
    await writeAppServerScript(
      workspace,
      "approval-interrupt.mjs",
      [
        "handleMessage = (message) => {",
        "  if (message.method === 'initialize') write({ id: message.id, result: {} });",
        "  if (message.method === 'thread/start') write({ id: message.id, result: { thread: { id: 'thread-1' } } });",
        "  if (message.method === 'turn/start') {",
        "    write({ id: message.id, result: { turn: { id: 'turn-1' } } });",
        "    write({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'pnpm test', cwd: process.cwd() } });",
        "  }",
        "  if (message.method === 'turn/interrupt') {",
        "    write({ id: message.id, result: {} });",
        "    write({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'interrupted' } } });",
        "  }",
        "};",
        "setInterval(() => undefined, 1000);",
      ],
    );
    const events: AgentRuntimeEvent[] = [];
    const session = codexAgent.createSession({
      profile: "standard",
      env: {
        ROAMCLI_AGENT_CODEX_COMMAND: process.execPath,
      },
      session: makeSession(workspace),
      cwd: workspace,
      prompt: "hello",
      emit: async (event) => {
        events.push(event);
      },
      requestApproval: async () => {
        await writeFile(approvalMarker, "pending");
        return new Promise(() => undefined);
      },
    });

    await session.start();
    await vi.waitFor(async () => {
      await expect(readFile(approvalMarker, "utf8")).resolves.toBe("pending");
    });

    await expect(
      Promise.race([
        Promise.resolve(session.control("interrupt")).then(() => "interrupted"),
        new Promise((resolve) => setTimeout(() => resolve("timed out"), 500)),
      ]),
    ).resolves.toBe("interrupted");

    await vi.waitFor(() => {
      expect(events).toContainEqual({ type: "status", status: "stopped" });
    });
  });

  it("fails app-server sessions when the process exits before a queued turn starts", async () => {
    const workspace = await mkdirTemp("roam-codex-app-server-exit-between-turns-");
    await writeAppServerScript(
      workspace,
      "exit-before-turn.mjs",
      [
        "handleMessage = (message) => {",
        "  if (message.method === 'initialize') write({ id: message.id, result: {} });",
        "  if (message.method === 'thread/start') {",
        "    write({ id: message.id, result: { thread: { id: 'thread-1' } } });",
        "    process.exit(0);",
        "  }",
        "};",
      ],
    );
    const events: AgentRuntimeEvent[] = [];
    const session = codexAgent.createSession({
      profile: "standard",
      env: {
        ROAMCLI_AGENT_CODEX_COMMAND: process.execPath,
      },
      session: makeSession(workspace),
      cwd: workspace,
      prompt: "hello",
      emit: async (event) => {
        events.push(event);
      },
      requestApproval: async () => ({
        approvalId: "approval-1",
        approved: true,
        signedAt: "2026-06-21T00:00:00.000Z",
        signature: "sig",
      }),
    });

    await session.start();

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "error",
        message: expect.stringContaining(
          "Codex app-server exited before the next turn started",
        ),
        code: "CODEX_APP_SERVER_ERROR",
      });
      expect(events).toContainEqual({ type: "status", status: "failed" });
    });
  });

  it("fails app-server sessions cleanly when approval creation fails", async () => {
    const workspace = await mkdirTemp("roam-codex-app-server-approval-fail-");
    await writeAppServerScript(
      workspace,
      "approval-fail.mjs",
      [
        "handleMessage = (message) => {",
        "  if (message.method === 'initialize') write({ id: message.id, result: {} });",
        "  if (message.method === 'thread/start') write({ id: message.id, result: { thread: { id: 'thread-1' } } });",
        "  if (message.method === 'turn/start') {",
        "    write({ id: message.id, result: { turn: { id: 'turn-1' } } });",
        "    write({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'pnpm test', cwd: process.cwd() } });",
        "  }",
        "};",
        "setInterval(() => undefined, 1000);",
      ],
    );
    const events: AgentRuntimeEvent[] = [];
    const session = codexAgent.createSession({
      profile: "standard",
      env: {
        ROAMCLI_AGENT_CODEX_COMMAND: process.execPath,
      },
      session: makeSession(workspace),
      cwd: workspace,
      prompt: "hello",
      emit: async (event) => {
        events.push(event);
      },
      requestApproval: async () => {
        throw new Error("approval store down");
      },
    });

    await session.start();

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "error",
        message: "approval store down",
        code: "CODEX_APP_SERVER_APPROVAL_ERROR",
      });
      expect(events).toContainEqual({ type: "status", status: "failed" });
    });
  });

  it("passes app-server network approval context to the approval chain", async () => {
    const workspace = await mkdirTemp("roam-codex-app-server-network-");
    await writeAppServerScript(
      workspace,
      "network-approval.mjs",
      [
        "handleMessage = (message) => {",
        "  if (message.method === 'initialize') write({ id: message.id, result: {} });",
        "  if (message.method === 'thread/start') write({ id: message.id, result: { thread: { id: 'thread-1' } } });",
        "  if (message.method === 'turn/start') {",
        "    write({ id: message.id, result: { turn: { id: 'turn-1' } } });",
        "    write({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', reason: 'Allow network', networkApprovalContext: { host: 'example.com', protocol: 'https' }, proposedNetworkPolicyAmendments: [{ host: 'example.com', action: 'allow' }] } });",
        "  }",
        "  if (message.id === 7 && message.result) {",
        "    write({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });",
        "  }",
        "};",
      ],
    );
    const approvals: unknown[] = [];
    const session = codexAgent.createSession({
      profile: "standard",
      env: {
        ROAMCLI_AGENT_CODEX_COMMAND: process.execPath,
      },
      session: makeSession(workspace),
      cwd: workspace,
      prompt: "hello",
      emit: async () => undefined,
      requestApproval: async (draft) => {
        approvals.push(draft);
        return {
          approvalId: "approval-1",
          approved: true,
          signedAt: "2026-06-21T00:00:00.000Z",
          signature: "sig",
        };
      },
    });

    await session.start();

    await vi.waitFor(() => {
      expect(approvals).toEqual([
        expect.objectContaining({
          kind: "execCommand",
          summary: "Allow network",
          payload: expect.objectContaining({
            networkApprovalContext: {
              host: "example.com",
              protocol: "https",
            },
            proposedNetworkPolicyAmendments: [
              { host: "example.com", action: "allow" },
            ],
          }),
        }),
      ]);
    });
  });

  it("passes app-server file change details to the approval chain", async () => {
    const workspace = await mkdirTemp("roam-codex-app-server-file-change-");
    await writeAppServerScript(
      workspace,
      "file-change.mjs",
      [
        "handleMessage = (message) => {",
        "  if (message.method === 'initialize') write({ id: message.id, result: {} });",
        "  if (message.method === 'thread/start') write({ id: message.id, result: { thread: { id: 'thread-1' } } });",
        "  if (message.method === 'turn/start') {",
        "    write({ id: message.id, result: { turn: { id: 'turn-1' } } });",
        "    write({ method: 'item/started', params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'item-1', type: 'fileChange', changes: [{ path: 'src/app.ts', kind: 'update', diff: '@@ -1 +1 @@' }], status: 'pending' }, startedAtMs: Date.now() } });",
        "    write({ id: 11, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', reason: 'Apply patch' } });",
        "  }",
        "  if (message.id === 11 && message.result) {",
        "    write({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });",
        "  }",
        "};",
      ],
    );
    const approvals: unknown[] = [];
    const session = codexAgent.createSession({
      profile: "standard",
      env: {
        ROAMCLI_AGENT_CODEX_COMMAND: process.execPath,
      },
      session: makeSession(workspace),
      cwd: workspace,
      prompt: "hello",
      emit: async () => undefined,
      requestApproval: async (draft) => {
        approvals.push(draft);
        return {
          approvalId: "approval-1",
          approved: true,
          signedAt: "2026-06-21T00:00:00.000Z",
          signature: "sig",
        };
      },
    });

    await session.start();

    await vi.waitFor(() => {
      expect(approvals).toEqual([
        expect.objectContaining({
          kind: "applyPatch",
          summary: "Apply patch",
          payload: expect.objectContaining({
            itemId: "item-1",
            fileChange: {
              id: "item-1",
              type: "fileChange",
              changes: [
                { path: "src/app.ts", kind: "update", diff: "@@ -1 +1 @@" },
              ],
              status: "pending",
            },
          }),
        }),
      ]);
    });
  });

  it("handles app-server permission approval requests", async () => {
    const workspace = await mkdirTemp("roam-codex-app-server-permissions-");
    await writeAppServerScript(
      workspace,
      "permissions.mjs",
      [
        "handleMessage = (message) => {",
        "  if (message.method === 'initialize') write({ id: message.id, result: {} });",
        "  if (message.method === 'thread/start') write({ id: message.id, result: { thread: { id: 'thread-1' } } });",
        "  if (message.method === 'turn/start') {",
        "    write({ id: message.id, result: { turn: { id: 'turn-1' } } });",
        "    write({ id: 8, method: 'item/permissions/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', environmentId: 'local', cwd: process.cwd(), reason: 'Need workspace write', permissions: { fileSystem: { write: [process.cwd()] }, network: { enabled: true } } } });",
        "  }",
        "  if (message.id === 8 && message.result) {",
        "    write({ method: 'item/completed', params: { item: { id: 'item-2', type: 'agentMessage', text: JSON.stringify(message.result) } } });",
        "    write({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });",
        "  }",
        "};",
      ],
    );
    const events: AgentRuntimeEvent[] = [];
    const approvals: unknown[] = [];
    const session = codexAgent.createSession({
      profile: "standard",
      env: {
        ROAMCLI_AGENT_CODEX_COMMAND: process.execPath,
      },
      session: makeSession(workspace),
      cwd: workspace,
      prompt: "hello",
      emit: async (event) => {
        events.push(event);
      },
      requestApproval: async (draft) => {
        approvals.push(draft);
        return {
          approvalId: "approval-1",
          approved: true,
          signedAt: "2026-06-21T00:00:00.000Z",
          signature: "sig",
        };
      },
    });

    await session.start();

    await vi.waitFor(() => {
      expect(approvals).toEqual([
        expect.objectContaining({
          kind: "execCommand",
          summary: "Need workspace write",
          payload: expect.objectContaining({
            permissions: {
              fileSystem: {
                write: [
                  expect.stringContaining(
                    "roam-codex-app-server-permissions",
                  ),
                ],
              },
              network: { enabled: true },
            },
          }),
        }),
      ]);
      expect(
        events.some(
          (event) =>
            event.type === "assistantOutput" &&
            event.content?.includes('"scope":"turn"') &&
            event.content.includes('"fileSystem"'),
        ),
      ).toBe(true);
    });
  });

  it("emits app-server artifact directives from completed messages", async () => {
    const workspace = await mkdirTemp("roam-codex-app-server-artifact-");
    await writeAppServerScript(
      workspace,
      "artifact.mjs",
      [
        "handleMessage = (message) => {",
        "  if (message.method === 'initialize') write({ id: message.id, result: {} });",
        "  if (message.method === 'thread/start') write({ id: message.id, result: { thread: { id: 'thread-1' } } });",
        "  if (message.method === 'turn/start') {",
        "    write({ id: message.id, result: { turn: { id: 'turn-1' } } });",
        "    write({ method: 'item/completed', params: { item: { id: 'item-1', type: 'agentMessage', text: 'ROAMCLI_ARTIFACT: {\"type\":\"artifact\",\"path\":\"result.log\",\"kind\":\"log\",\"mimeType\":\"text/plain\"}' } } });",
        "    write({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });",
        "  }",
        "};",
      ],
    );
    const events: AgentRuntimeEvent[] = [];
    const session = codexAgent.createSession({
      profile: "standard",
      env: {
        ROAMCLI_AGENT_CODEX_COMMAND: process.execPath,
      },
      session: makeSession(workspace),
      cwd: workspace,
      prompt: "hello",
      emit: async (event) => {
        events.push(event);
      },
      requestApproval: async () => ({
        approvalId: "approval-1",
        approved: true,
        signedAt: "2026-06-21T00:00:00.000Z",
        signature: "sig",
      }),
    });

    await session.start();

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "artifact",
        draft: {
          path: "result.log",
          kind: "log",
          mimeType: "text/plain",
        },
      });
    });
  });

  it.skipIf(process.env.ROAMCLI_RUN_CODEX_APP_SERVER_INTEGRATION !== "1")(
    "runs a real codex app-server turn when explicitly enabled",
    async () => {
      const workspace = await mkdirTemp("roam-codex-real-app-server-");
      const events: AgentRuntimeEvent[] = [];
      const session = codexAgent.createSession({
        profile: "standard",
        env: process.env,
        session: makeSession(workspace),
        cwd: workspace,
        prompt: "Reply with exactly: ROAMCLI_OK",
        emit: async (event) => {
          events.push(event);
        },
        requestApproval: async () => ({
          approvalId: "approval-1",
          approved: false,
          signedAt: "2026-06-21T00:00:00.000Z",
          signature: "sig",
        }),
      });

      await session.start();

      await vi.waitFor(
        () => {
          expect(events.some((event) => event.type === "thread")).toBe(true);
          expect(
            events.some(
              (event) =>
                event.type === "assistantOutput" &&
                typeof event.content === "string" &&
                event.content.includes("ROAMCLI_OK"),
            ),
          ).toBe(true);
          expect(events).toContainEqual({ type: "status", status: "completed" });
        },
        { timeout: 120_000 },
      );
    },
    130_000,
  );

  it("supports JSON array and shell-like args overrides", () => {
    expect(parseArgs('["--one","two words"]')).toEqual(["--one", "two words"]);
    expect(parseArgs('exec --sandbox "danger full"')).toEqual([
      "exec",
      "--sandbox",
      "danger full",
    ]);
  });

  it("lists codex skills from nearest project roots before global roots", async () => {
    const workspace = await mkdirTemp("roam-codex-skills-");
    const home = await mkdirTemp("roam-codex-home-");
    const repo = join(workspace, "repo");
    const sessionCwd = join(repo, "packages", "app");
    await mkdir(sessionCwd, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: repo });
    await writeSkill(
      join(sessionCwd, ".codex", "skills", "local-plan"),
      "plan",
      "Local plan",
    );
    await writeSkill(
      join(repo, ".agents", "skills", "repo-review"),
      "review",
      "Repo review",
    );
    await writeSkill(
      join(home, ".agents", "skills", "global-plan"),
      "plan",
      "Global plan",
    );
    await writeSkill(
      join(home, ".codex", "skills", "global-docs"),
      "docs",
      "Global docs",
    );
    const localSkillPath = await realpath(
      join(sessionCwd, ".codex", "skills", "local-plan"),
    );

    const skills = await listCodexSkills(workspace, sessionCwd, {
      HOME: home,
    });

    expect(skills.map((skill) => skill.name)).toEqual([
      "plan",
      "review",
      "docs",
    ]);
    expect(skills[0]).toMatchObject({
      name: "plan",
      description: "Local plan",
      sourceType: "project",
      sourcePath: localSkillPath,
    });
    expect(skills[2]).toMatchObject({
      name: "docs",
      sourceType: "global",
    });
  });

  it("lists CODEX_HOME skills before home fallback roots", async () => {
    const workspace = await mkdirTemp("roam-codex-skills-");
    const home = await mkdirTemp("roam-codex-home-");
    const codexHome = await mkdirTemp("roam-codex-custom-home-");
    const sessionCwd = join(workspace, "repo");
    await mkdir(sessionCwd, { recursive: true });
    await writeSkill(
      join(codexHome, "skills", "custom-docs"),
      "docs",
      "Custom Codex docs",
    );
    await writeSkill(
      join(home, ".agents", "skills", "global-review"),
      "review",
      "Global review",
    );
    await writeSkill(
      join(home, ".codex", "skills", "home-docs"),
      "docs",
      "Home Codex docs",
    );

    const skills = await listCodexSkills(workspace, sessionCwd, {
      CODEX_HOME: codexHome,
      HOME: home,
    });

    expect(skills.map((skill) => skill.name)).toEqual(["docs", "review"]);
    expect(skills[0]).toMatchObject({
      name: "docs",
      description: "Custom Codex docs",
      sourceType: "global",
    });
  });

  it("returns no skills when the configured base path escapes the workspace", async () => {
    const workspace = await mkdirTemp("roam-codex-skills-workspace-");
    const outside = await mkdirTemp("roam-codex-skills-outside-");

    await writeSkill(
      join(outside, ".codex", "skills", "outside"),
      "outside",
      "Outside",
    );

    await expect(
      listCodexSkills(workspace, outside, { HOME: outside }),
    ).resolves.toEqual([]);
  });
});

async function mkdirTemp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeAppServerScript(
  workspace: string,
  name: string,
  bodyLines: string[],
): Promise<string> {
  void name;
  const script = join(workspace, "app-server");
  await writeFile(
    script,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "process.stdin.setEncoding('utf8');",
      "let buffer = '';",
      "let handleMessage = () => undefined;",
      "function write(message) { process.stdout.write(`${JSON.stringify(message)}\\n`); }",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += chunk;",
      "  const lines = buffer.split(/\\r?\\n/);",
      "  buffer = lines.pop() ?? '';",
      "  for (const line of lines) {",
      "    if (!line) continue;",
      "    handleMessage(JSON.parse(line));",
      "  }",
      "});",
      ...bodyLines,
      "",
    ].join("\n"),
  );
  await chmod(script, 0o755);
  return script;
}

function makeSession(cwd: string): AgentSessionContext["session"] {
  return {
    id: "s1",
    title: "Session",
    projectId: "project-1",
    runnerId: "runner-1",
    agent: "codex",
    status: "pending",
    executionMode: "direct",
    executionFolder: cwd,
    cwd,
    createdAt: "2026-06-21T00:00:00.000Z",
    updatedAt: "2026-06-21T00:00:00.000Z",
  };
}

async function writeSkill(
  directory: string,
  name: string,
  description: string,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${description}`, "---", ""].join(
      "\n",
    ),
  );
}
