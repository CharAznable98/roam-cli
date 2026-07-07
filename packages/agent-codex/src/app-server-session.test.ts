import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  AgentRuntimeEvent,
  AgentSessionContext,
} from "@roamcli/agent-plugin-sdk";
import type { Session } from "@roamcli/shared/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcess = vi.hoisted(() => ({
  children: [] as unknown[],
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return {
    ...actual,
    spawn: childProcess.spawn,
  };
});

import { CodexAppServerSession } from "./app-server-session.js";

describe("CodexAppServerSession", () => {
  beforeEach(() => {
    childProcess.children = [];
    childProcess.spawn.mockImplementation(() => {
      const child = fakeChild();
      childProcess.children.push(child);
      return child;
    });
  });

  it("keeps running after a completed turn until the root thread is idle", async () => {
    const { child, events } = await launchSession();

    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await settle();

    expect(statusEvents(events)).toEqual([]);
    expect(child.killedSignals).toEqual([]);

    child.notify("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "idle" },
    });

    await waitFor(() => statusEvents(events).includes("completed"));
    expect(statusEvents(events)).toEqual(["completed"]);
    expect(child.killedSignals).toEqual(["SIGTERM"]);
  });

  it("waits for turn completion when root idle arrives first", async () => {
    const { child, events } = await launchSession();

    child.notify("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "idle" },
    });
    await settle();

    expect(statusEvents(events)).toEqual([]);

    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });

    await waitFor(() => statusEvents(events).includes("completed"));
    expect(child.killedSignals).toEqual(["SIGTERM"]);
  });

  it("queues follow-up input when root idle arrives before turn completion", async () => {
    const { child, events, session } = await launchSession();

    child.notify("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "idle" },
    });
    await settle();

    session.deliverInput({ content: "next prompt" });
    await settle();

    expect(child.requests("turn/steer")).toHaveLength(0);
    expect(child.requests("turn/start")).toHaveLength(1);

    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });

    const secondTurn = await waitForRequest(child, "turn/start", 2);
    expect(statusEvents(events)).toEqual([]);
    child.respond(secondTurn.id, { turn: { id: "turn-2" } });
    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "completed" },
    });
    child.notify("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "idle" },
    });

    await waitFor(() => statusEvents(events).includes("completed"));
    expect(statusEvents(events)).toEqual(["completed"]);
  });

  it("ignores non-root thread idle notifications", async () => {
    const { child, events } = await launchSession();

    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    child.notify("thread/status/changed", {
      threadId: "child-thread",
      status: { type: "idle" },
    });
    await settle();

    expect(statusEvents(events)).toEqual([]);
    expect(child.killedSignals).toEqual([]);
  });

  it("keeps root idle gating on the original thread after child threads start", async () => {
    const { child, events } = await launchSession();

    child.notify("thread/started", {
      thread: { id: "child-thread" },
    });
    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    child.notify("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "idle" },
    });

    await waitFor(() => statusEvents(events).includes("completed"));
    expect(statusEvents(events)).toEqual(["completed"]);
    expect(child.killedSignals).toEqual(["SIGTERM"]);
  });

  it("ignores child turn lifecycle events while waiting for the root turn", async () => {
    const { child, events } = await launchSession();

    child.notify("turn/completed", {
      threadId: "child-thread",
      turn: { id: "child-turn-1", status: "completed" },
    });
    await settle();

    child.notify("turn/started", {
      threadId: "child-thread",
      turn: { id: "child-turn-2" },
    });
    child.notify("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "idle" },
    });
    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });

    await waitFor(() => statusEvents(events).includes("completed"));
    expect(statusEvents(events)).toEqual(["completed"]);
    expect(child.killedSignals).toEqual(["SIGTERM"]);
  });

  it("ignores turn completion for a different turn on the root thread", async () => {
    const { child, events } = await launchSession();

    child.notify("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "idle" },
    });
    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "other-turn", status: "completed" },
    });
    await settle();

    expect(statusEvents(events)).toEqual([]);
    expect(child.killedSignals).toEqual([]);

    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });

    await waitFor(() => statusEvents(events).includes("completed"));
    expect(statusEvents(events)).toEqual(["completed"]);
    expect(child.killedSignals).toEqual(["SIGTERM"]);
  });

  it("accepts turn completion without a thread id when the turn id matches", async () => {
    const { child, events } = await launchSession();

    child.notify("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "idle" },
    });
    child.notify("turn/completed", {
      turn: { id: "turn-1", status: "completed" },
    });

    await waitFor(() => statusEvents(events).includes("completed"));
    expect(statusEvents(events)).toEqual(["completed"]);
    expect(child.killedSignals).toEqual(["SIGTERM"]);
  });

  it("ignores anonymous turn completion while the active root turn id is known", async () => {
    const { child, events } = await launchSession();

    child.notify("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "idle" },
    });
    child.notify("turn/completed", {
      turn: { status: "completed" },
    });
    await settle();

    expect(statusEvents(events)).toEqual([]);
    expect(child.killedSignals).toEqual([]);

    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { status: "completed" },
    });

    await waitFor(() => statusEvents(events).includes("completed"));
    expect(statusEvents(events)).toEqual(["completed"]);
    expect(child.killedSignals).toEqual(["SIGTERM"]);
  });

  it("requires the root thread id for completion while the root turn id is unknown", async () => {
    const { child, events } = await launchSession({
      turnStartResult: { turn: {} },
    });

    child.notify("turn/completed", {
      turn: { id: "child-turn", status: "completed" },
    });
    child.notify("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "idle" },
    });
    await settle();

    expect(statusEvents(events)).toEqual([]);
    expect(child.killedSignals).toEqual([]);

    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });

    await waitFor(() => statusEvents(events).includes("completed"));
    expect(statusEvents(events)).toEqual(["completed"]);
    expect(child.killedSignals).toEqual(["SIGTERM"]);
  });

  it("requires the root thread id before seeding an unknown root turn id", async () => {
    const { child, events } = await launchSession({
      turnStartResult: { turn: {} },
    });

    child.notify("turn/started", {
      turn: { id: "child-turn" },
    });
    child.notify("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "idle" },
    });
    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });

    await waitFor(() => statusEvents(events).includes("completed"));
    expect(statusEvents(events)).toEqual(["completed"]);
    expect(child.killedSignals).toEqual(["SIGTERM"]);
  });

  it("queues the next turn until the root thread becomes idle", async () => {
    const { child, events, session } = await launchSession();

    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await settle();

    session.deliverInput({ content: "next prompt" });
    await settle();

    expect(child.requests("turn/start")).toHaveLength(1);
    expect(child.requests("turn/steer")).toHaveLength(0);
    expect(statusEvents(events)).toEqual([]);

    child.notify("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "idle" },
    });

    const secondTurn = await waitForRequest(child, "turn/start", 2);
    expect(statusEvents(events)).toEqual([]);
    child.respond(secondTurn.id, { turn: { id: "turn-2" } });
    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-2", status: "completed" },
    });
    child.notify("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "idle" },
    });

    await waitFor(() => statusEvents(events).includes("completed"));
    expect(statusEvents(events)).toEqual(["completed"]);
  });

  it("stops cleanly while queued input is waiting for root idle", async () => {
    const { child, events, session } = await launchSession();

    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    await settle();

    session.deliverInput({ content: "next prompt" });
    await settle();

    await session.control("stop");
    await settle();

    expect(statusEvents(events)).toEqual(["stopped"]);
    expect(child.requests("turn/start")).toHaveLength(1);
    expect(child.killedSignals).toEqual(["SIGTERM"]);
  });

  it("fails when the root thread enters systemError", async () => {
    const { child, events } = await launchSession();

    child.notify("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "systemError", message: "root exploded" },
    });

    await waitFor(() => statusEvents(events).includes("failed"));
    expect(statusEvents(events)).toEqual(["failed"]);
    expect(
      events.some(
        (event) => event.type === "error" && event.message === "root exploded",
      ),
    ).toBe(true);
    expect(child.killedSignals).toEqual(["SIGTERM"]);
  });

  it("passes stored runtime config to thread and turn requests", async () => {
    const { child } = await launchSession({
      session: {
        id: "session-1",
        agent: "codex",
        agentRuntimeConfig: {
          model: "gpt-5.4-codex",
          reasoningEffort: "high",
          serviceTier: "flex",
        },
      } as Session,
    });

    const threadStart = child.requests("thread/start")[0];
    expect(threadStart?.params).toMatchObject({
      model: "gpt-5.4-codex",
      serviceTier: "flex",
    });
    const turnStart = child.requests("turn/start")[0];
    expect(turnStart?.params).toMatchObject({
      model: "gpt-5.4-codex",
      serviceTier: "flex",
      effort: "high",
    });
  });

  it("does not emit activity for stderr, lifecycle events, or output streams", async () => {
    const { child, events } = await launchSession();

    (child.stderr as PassThrough).write(
      "debug line that should stay out of activity\n",
    );
    child.notify("thread/status/changed", {
      threadId: "thread-1",
      status: { type: "active", activeFlags: [] },
    });
    child.notify("turn/completed", {
      threadId: "thread-1",
      turn: { id: "turn-1", status: "completed" },
    });
    child.notify("command/exec/outputDelta", {
      processId: "process-1",
      deltaBase64: "bG9n",
    });
    child.notify("item/commandExecution/outputDelta", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "command-1",
      delta: "test output",
    });
    child.notify("process/outputDelta", {
      processHandle: "process-2",
      deltaBase64: "bG9n",
    });
    await settle();

    expect(activityEvents(events)).toEqual([]);
  });

  it("preserves startup stderr in early app-server exit errors", async () => {
    const events: AgentRuntimeEvent[] = [];
    const session = new CodexAppServerSession({
      command: "codex",
      args: ["app-server"],
      context: makeContext(events),
    });

    const start = session.start();
    const child = childProcess.children[0] as FakeChild;
    await waitFor(() => child.requests("initialize").length === 1);

    (child.stderr as PassThrough).write(
      "auth failed: run codex login before app-server\n",
    );
    child.emit("close", 1, null);

    await expect(start).rejects.toThrow(
      /auth failed: run codex login before app-server/,
    );
    expect(activityEvents(events)).toEqual([]);
  });

  it("emits concise activity for allowlisted app-server item starts", async () => {
    const { child, events } = await launchSession();

    child.notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "command-1",
        type: "commandExecution",
        command: "pnpm test -- --runInBand",
      },
    });
    child.notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "command-2",
        type: "commandExecution",
        status: "running",
        command: "pnpm build",
      },
    });
    child.notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "command-1",
        type: "commandExecution",
        command: "pnpm test -- --runInBand",
      },
    });
    child.notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "patch-1",
        type: "fileChange",
        changes: [{ path: "a.ts" }, { path: "b.ts" }],
      },
    });
    child.notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "mcp-1",
        type: "mcpToolCall",
        server: "GitHub",
        tool: "search",
      },
    });
    child.notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "dynamic-1",
        type: "dynamicToolCall",
        namespace: "images",
        tool: "generate",
      },
    });
    child.notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "search-1", type: "webSearch" },
    });
    child.notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "image-1", type: "imageGeneration" },
    });
    child.notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "image-view-1", type: "imageView" },
    });
    child.notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { id: "compact-1", type: "contextCompaction" },
    });
    child.notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "agent-1",
        type: "collabToolCall",
        tool: "wait",
      },
    });
    child.notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "agent-2",
        type: "collabAgentToolCall",
        tool: "spawn_agent",
      },
    });
    await settle();

    expect(activityEvents(events).map(({ kind, label }) => ({ kind, label })))
      .toEqual([
        { kind: "tool", label: "Command pnpm test -- --runInBand" },
        { kind: "tool", label: "Running pnpm build" },
        { kind: "tool", label: "Editing 2 files" },
        { kind: "tool", label: "Using GitHub search" },
        { kind: "tool", label: "Using images generate" },
        { kind: "tool", label: "Searching web" },
        { kind: "tool", label: "Generating image" },
        { kind: "tool", label: "Viewing image" },
        { kind: "status", label: "Compacting context" },
        { kind: "status", label: "Waiting for agent" },
        { kind: "status", label: "Starting agent" },
      ]);
  });

  it("awaits item start activity before processing later item events", async () => {
    let releaseStartActivity!: () => void;
    const startActivityBlocked = new Promise<void>((resolve) => {
      releaseStartActivity = resolve;
    });
    const { child, events } = await launchSession({
      context: (events) => ({
        ...makeContext(events),
        emit: async (event) => {
          if (event.type === "activity" && event.label === "Command slow") {
            await startActivityBlocked;
          }
          events.push(event);
        },
      }),
    });

    child.notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "command-1",
        type: "commandExecution",
        command: "slow",
      },
    });
    child.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "command-1",
        type: "commandExecution",
        status: "failed",
        command: "slow",
      },
    });
    await settle();
    await settle();

    expect(activityEvents(events)).toEqual([]);
    releaseStartActivity();
    await waitFor(() => activityEvents(events).length === 2);
    expect(activityEvents(events).map(({ label }) => label)).toEqual([
      "Command slow",
      "Command failed: slow",
    ]);
  });

  it("filters item activity to the current root turn", async () => {
    const { child, events } = await launchSession();

    child.notify("item/started", {
      threadId: "child-thread",
      turnId: "turn-1",
      item: {
        id: "child-thread-command",
        type: "commandExecution",
        command: "pnpm child-thread",
      },
    });
    child.notify("item/started", {
      threadId: "thread-1",
      turnId: "child-turn",
      item: {
        id: "child-turn-command",
        type: "commandExecution",
        command: "pnpm child-turn",
      },
    });
    child.notify("item/completed", {
      threadId: "child-thread",
      turnId: "turn-1",
      item: {
        id: "child-thread-failed",
        type: "commandExecution",
        command: "pnpm child-thread",
        status: "failed",
      },
    });
    child.notify("item/completed", {
      threadId: "thread-1",
      turnId: "child-turn",
      item: {
        id: "child-turn-failed",
        type: "commandExecution",
        command: "pnpm child-turn",
        status: "failed",
      },
    });
    child.notify("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "root-command",
        type: "commandExecution",
        command: "pnpm root",
      },
    });
    await settle();

    expect(activityEvents(events).map(({ kind, label }) => ({ kind, label })))
      .toEqual([{ kind: "tool", label: "Command pnpm root" }]);
  });

  it("emits completed item activity only for attention states", async () => {
    const { child, events } = await launchSession();

    child.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "command-ok",
        type: "commandExecution",
        command: "pnpm test",
        status: "completed",
      },
    });
    child.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "command-failed",
        type: "commandExecution",
        command: "pnpm test",
        status: "failed",
      },
    });
    child.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "patch-declined",
        type: "fileChange",
        changes: [{ path: "a.ts" }],
        status: "declined",
      },
    });
    child.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "dynamic-failed",
        type: "dynamicToolCall",
        namespace: "images",
        tool: "generate",
        success: false,
      },
    });
    child.notify("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        id: "agent-failed",
        type: "collabToolCall",
        tool: "wait",
        status: "failed",
      },
    });
    await settle();

    expect(activityEvents(events).map(({ kind, label }) => ({ kind, label })))
      .toEqual([
        { kind: "tool", label: "Command failed: pnpm test" },
        { kind: "tool", label: "File edit declined 1 file" },
        { kind: "tool", label: "Tool failed: images generate" },
        { kind: "status", label: "Agent coordination failed" },
      ]);
  });

  it("keeps low-frequency Codex warning and retry activity", async () => {
    const { child, events } = await launchSession();

    child.notify("error", {
      threadId: "thread-1",
      turnId: "turn-1",
      error: { message: "temporary upstream issue" },
      willRetry: true,
    });
    child.notify("warning", {
      threadId: "thread-1",
      message: "model quota nearly exhausted",
    });
    child.notify("warning", {
      threadId: "child-thread",
      message: "child warning should stay out of activity",
    });
    child.notify("configWarning", {
      summary: "global config summary",
    });
    child.notify("model/rerouted", {
      threadId: "thread-1",
      turnId: "turn-1",
      fromModel: "gpt-5.5",
      toModel: "gpt-5.4-mini",
    });
    child.notify("model/rerouted", {
      threadId: "thread-1",
      turnId: "child-turn",
      fromModel: "gpt-5.5",
      toModel: "gpt-5.4-mini",
    });
    await settle();

    expect(activityEvents(events).map(({ kind, label }) => ({ kind, label })))
      .toEqual([
        { kind: "system", label: "temporary upstream issue" },
        { kind: "system", label: "Codex warning: model quota nearly exhausted" },
        { kind: "system", label: "Codex warning: global config summary" },
        { kind: "system", label: "Model rerouted to gpt-5.4-mini" },
      ]);
  });
});

async function launchSession(
  options: {
    session?: Session;
    turnStartResult?: unknown;
    context?: (events: AgentRuntimeEvent[]) => AgentSessionContext;
  } = {},
): Promise<{
  child: FakeChild;
  events: AgentRuntimeEvent[];
  session: CodexAppServerSession;
}> {
  const events: AgentRuntimeEvent[] = [];
  const session = new CodexAppServerSession({
    command: "codex",
    args: ["app-server"],
    context: options.context
      ? options.context(events)
      : makeContext(events, options.session),
  });

  const start = session.start();
  const child = childProcess.children[0] as FakeChild;

  const initialize = await waitForRequest(child, "initialize");
  child.respond(initialize.id, {});
  const threadStart = await waitForRequest(child, "thread/start");
  child.respond(threadStart.id, { thread: { id: "thread-1" } });
  await start;

  const turnStart = await waitForRequest(child, "turn/start");
  child.respond(
    turnStart.id,
    options.turnStartResult ?? { turn: { id: "turn-1" } },
  );

  return { child, events, session };
}

function makeContext(
  events: AgentRuntimeEvent[],
  session: Session = { id: "session-1", agent: "codex" } as Session,
): AgentSessionContext {
  return {
    profile: "standard",
    env: {},
    session,
    cwd: "/workspace",
    prompt: "hello",
    emit: async (event) => {
      events.push(event);
    },
    requestApproval: async () => ({
      approvalId: "approval-1",
      approved: true,
      signedAt: "2026-07-02T00:00:00.000Z",
      signature: "sig",
    }),
  };
}

function statusEvents(events: readonly AgentRuntimeEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "status" ? [event.status] : [],
  );
}

function activityEvents(
  events: readonly AgentRuntimeEvent[],
): Array<Extract<AgentRuntimeEvent, { type: "activity" }>> {
  return events.flatMap((event) => (event.type === "activity" ? [event] : []));
}

async function waitForRequest(
  child: FakeChild,
  method: string,
  count = 1,
): Promise<JsonRpcRequest> {
  await waitFor(() => child.requests(method).length >= count);
  return child.requests(method)[count - 1]!;
}

async function waitFor(assertion: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (assertion()) {
      return;
    }
    await settle();
  }
  throw new Error("Timed out waiting for condition");
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface JsonRpcRequest {
  id: number | string;
  method: string;
  params?: unknown;
}

interface FakeChild extends ChildProcessWithoutNullStreams {
  killedSignals: NodeJS.Signals[];
  notify(method: string, params?: unknown): void;
  requests(method: string): JsonRpcRequest[];
  respond(id: number | string, result: unknown): void;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killedSignals = [];
  const writes: JsonRpcRequest[] = [];
  child.stdin.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (line.length === 0) {
        continue;
      }
      const message = JSON.parse(line) as JsonRpcRequest;
      if ("id" in message && typeof message.method === "string") {
        writes.push(message);
      }
    }
  });
  child.kill = ((signal?: NodeJS.Signals | number) => {
    if (typeof signal === "string") {
      child.killedSignals.push(signal);
    }
    child.emit("close", null, signal ?? null);
    return true;
  }) as FakeChild["kill"];
  child.notify = (method, params) => {
    (child.stdout as PassThrough).write(
      `${JSON.stringify({ method, params })}\n`,
    );
  };
  child.requests = (method) =>
    writes.filter((request) => request.method === method);
  child.respond = (id, result) => {
    (child.stdout as PassThrough).write(`${JSON.stringify({ id, result })}\n`);
  };
  return child;
}
