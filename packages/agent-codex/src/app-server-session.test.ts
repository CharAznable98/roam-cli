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
});

async function launchSession(): Promise<{
  child: FakeChild;
  events: AgentRuntimeEvent[];
  session: CodexAppServerSession;
}> {
  const events: AgentRuntimeEvent[] = [];
  const session = new CodexAppServerSession({
    command: "codex",
    args: ["app-server"],
    context: makeContext(events),
  });

  const start = session.start();
  const child = childProcess.children[0] as FakeChild;

  const initialize = await waitForRequest(child, "initialize");
  child.respond(initialize.id, {});
  const threadStart = await waitForRequest(child, "thread/start");
  child.respond(threadStart.id, { thread: { id: "thread-1" } });
  await start;

  const turnStart = await waitForRequest(child, "turn/start");
  child.respond(turnStart.id, { turn: { id: "turn-1" } });

  return { child, events, session };
}

function makeContext(events: AgentRuntimeEvent[]): AgentSessionContext {
  return {
    profile: "standard",
    env: {},
    session: { id: "session-1", agent: "codex" } as Session,
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
