import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionContext,
  ApprovalDecision,
  UserInputDecision,
} from "@roamcli/agent-plugin-sdk";
import { piAgent, listPiSkills, listPiRuntimeConfigOptions } from "./index.js";
import approvalExtension from "./approval-extension.js";
import { piInvocation } from "./command.js";
import { PiRpc } from "./rpc.js";

const fixture = fileURLToPath(
  new URL("../test/fixtures/pi-rpc.mjs", import.meta.url),
);
const temporary: string[] = [];
const sessions: AgentSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  vi.unstubAllEnvs();
  // Windows needs the gracefully shutting down child to release its cwd.
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (const directory of temporary.splice(0))
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 50,
    });
});
async function setup(
  prompt = "hello",
  profile: AgentSessionContext["profile"] = "standard",
) {
  const cwd = await mkdtemp(join(tmpdir(), "roam-pi-"));
  temporary.push(cwd);
  const events: AgentRuntimeEvent[] = [];
  const context: AgentSessionContext = {
    profile,
    cwd,
    prompt,
    env: {
      ...process.env,
      ROAMCLI_AGENT_PI_COMMAND: fixture,
      PI_TEST_LOG: join(cwd, "rpc.jsonl"),
    },
    session: {
      id: "s1",
      title: "Pi",
      projectId: "p1",
      runnerId: "r1",
      agent: "pi",
      status: "pending",
      executionMode: "direct",
      executionFolder: cwd,
      cwd,
      createdAt: "2026-11-15T00:00:00.000Z",
      updatedAt: "2026-11-15T00:00:00.000Z",
    },
    emit: async (event) => {
      events.push(event);
    },
    requestApproval: async () => ({
      approvalId: "a1",
      approved: false,
      signedAt: "2026-11-15T00:00:00.000Z",
    }),
  };
  const create = () => {
    const session = piAgent.createSession(context);
    sessions.push(session);
    return session;
  };
  const log = async () =>
    (await readFile(join(cwd, "rpc.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { cwd, context, events, create, log };
}
const completed = (events: AgentRuntimeEvent[]) =>
  events.some(
    (event) => event.type === "status" && event.status === "completed",
  );
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("Pi RPC integration", () => {
  it("advertises resume, images and durable input acceptance", () => {
    expect(
      piAgent.buildCapability({ profile: "standard", env: {} }),
    ).toMatchObject({
      kind: "pi",
      parser: "pi-rpc",
      supportsResume: true,
      supportsImages: true,
      supportsDurableSessionStart: true,
      pluginName: "@roamcli/agent-pi",
    });
  });
  it("waits for prompt acceptance even when final events arrive first, preserving Unicode and authoritative output", async () => {
    const { create, events, log } = await setup("before-ack");
    await create().start();
    await vi.waitFor(() => expect(completed(events)).toBe(true));
    expect(
      events.filter((event) => event.type === "assistantOutput"),
    ).toMatchObject([
      { content: "partial ", mode: "append", done: false },
      { content: "Unicode\u2028正文\u2029done", mode: "replace", done: true },
    ]);
    expect(events.findIndex((event) => event.type === "thread")).toBeLessThan(
      events.findIndex((event) => event.type === "assistantOutput"),
    );
    expect(
      (await log()).filter((command) => command.type === "prompt"),
    ).toHaveLength(1);
  });
  it("accepts steering and deduplicates delivery IDs", async () => {
    const { create, events, log } = await setup("wait");
    const session = create();
    await session.start();
    expect(completed(events)).toBe(false);
    const first = session.deliverInput({
      content: "finish",
      deliveryId: "delivery-1",
    });
    const duplicate = session.deliverInput({
      content: "finish",
      deliveryId: "delivery-1",
    });
    await Promise.all([first, duplicate]);
    await vi.waitFor(() => expect(completed(events)).toBe(true));
    const prompts = (await log()).filter(
      (command) => command.type === "prompt",
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatchObject({
      message: "finish",
      streamingBehavior: "steer",
    });
  });
  it("retries an explicitly rejected delivery ID without duplicating accepted input", async () => {
    const { create, events, log } = await setup("wait");
    const session = create();
    await session.start();
    const input = { content: "reject-once", deliveryId: "retry-delivery" };
    await expect(session.deliverInput(input)).rejects.toThrow(
      "rejected before acceptance",
    );
    await session.deliverInput(input);
    await vi.waitFor(() => expect(completed(events)).toBe(true));
    expect(
      (await log()).filter((command) => command.message === "reject-once"),
    ).toHaveLength(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "assistantOutput",
        content: "reject-once",
        done: true,
      }),
    );
  });
  it("persists an extension-only native session and resumes its first normal conversation", async () => {
    const { create, context, events } = await setup("handled-empty");
    await create().start();
    await vi.waitFor(() => expect(completed(events)).toBe(true));
    const thread = events.find((event) => event.type === "thread");
    if (thread?.type !== "thread") throw new Error("Missing thread");
    const saved = (await readFile(thread.threadId, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(saved[0]).toMatchObject({
      type: "session",
      version: 3,
      id: "native-id",
      cwd: context.cwd,
    });
    expect(saved[1]).toMatchObject({
      type: "model_change",
      provider: "provider-a",
      modelId: "model",
    });
    context.resumeThreadId = thread.threadId;
    context.prompt = "first normal conversation";
    events.length = 0;
    await create().start();
    await vi.waitFor(() => expect(completed(events)).toBe(true));
    expect(events).toContainEqual({
      type: "thread",
      threadId: thread.threadId,
    });
    expect(events.some((event) => event.type === "error")).toBe(false);
    const resumed = (await readFile(thread.threadId, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(resumed.slice(0, saved.length)).toEqual(saved);
    expect(resumed.at(-1).message).toMatchObject({
      role: "user",
      content: [{ text: "first normal conversation" }],
    });
  });
  it.each([
    ["input", "中文回答", { value: "中文回答" }],
    ["editor", "edited text", { value: "edited text" }],
    ["select", "乙", { value: "乙" }],
    ["confirm", "Yes", { confirmed: true }],
  ])(
    "accepts %s before its handler completes and uses the Runner free-text contract",
    async (method, content, response) => {
      const { create, context, events, log } = await setup(`dialog:${method}`);
      const answer = deferred<UserInputDecision>();
      const request = vi.fn(async (draft) => {
        // Runner's input tracker accepts one non-secret free-text question.
        expect(draft.questions).toHaveLength(1);
        expect(draft.questions[0]).toMatchObject({
          isOther: false,
          isSecret: false,
        });
        expect(draft.questions[0].options?.length ?? 0).toBe(0);
        return answer.promise;
      });
      context.requestUserInput = request;
      const starting = create().start();
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      await expect(starting).resolves.toBeUndefined();
      expect(completed(events)).toBe(false);
      if (method === "select")
        expect(request.mock.calls[0]?.[0].questions[0].question).toContain(
          "甲, 乙",
        );
      answer.resolve({
        inputRequestId: "question-1",
        content,
        answeredAt: "2026-11-15T00:00:00.000Z",
      });
      await vi.waitFor(() => expect(completed(events)).toBe(true));
      expect(
        (await log()).find(
          (command) => command.type === "extension_ui_response",
        ),
      ).toMatchObject({ id: "user-dialog", ...response });
      expect(events.some((event) => event.type === "error")).toBe(false);
    },
  );
  it("diagnoses unsupported startup extension dialogs without asking the user or submitting the prompt", async () => {
    const { create, context, events, log } = await setup("hello after startup");
    context.env.PI_TEST_STARTUP_UI = "1";
    const request = vi.fn(async () => ({
      inputRequestId: "startup-question",
      content: "continue",
      answeredAt: "2026-11-15T00:00:00.000Z",
    }));
    context.requestUserInput = request;
    await expect(create().start()).rejects.toThrow(
      "Pi RPC does not support extension dialogs during startup",
    );
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: "status", status: "failed" }),
    );
    expect(request).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === "thread")).toBe(false);
    const commands = existsSync(join(context.cwd, "rpc.jsonl"))
      ? await log()
      : [];
    expect(commands.some((command) => command.type === "prompt")).toBe(false);
    expect(completed(events)).toBe(false);
  });
  it("withdraws an expired native dialog before presenting its next question", async () => {
    const { create, context, events, log } = await setup("timed-dialogs");
    let active = false;
    const cancelled: string[] = [];
    context.requestUserInput = async (draft) => {
      if (active)
        throw new Error("Session already has a pending user input request");
      if (draft.summary === "Second question")
        return {
          inputRequestId: "second",
          content: "second answer",
          answeredAt: "now",
        };
      active = true;
      return new Promise((_resolve, reject) => {
        draft.signal?.addEventListener(
          "abort",
          () => {
            active = false;
            cancelled.push(draft.summary);
            reject(draft.signal?.reason);
          },
          { once: true },
        );
      });
    };
    await create().start();
    await vi.waitFor(() => expect(completed(events)).toBe(true));
    expect(cancelled).toEqual(["First timed question"]);
    expect(events).toContainEqual({
      type: "activity",
      kind: "system",
      label: "SECOND_ANSWER:second answer",
    });
    expect(
      (await log()).find((command) => command.id === "next-dialog"),
    ).toMatchObject({ value: "second answer" });
  });
  it("persists a first extension command stopped at user input and resumes the same native file", async () => {
    const { create, context, events } = await setup("dialog:input");
    const cancelled = vi.fn();
    context.requestUserInput = async (draft) =>
      new Promise((_resolve, reject) => {
        draft.signal?.addEventListener(
          "abort",
          () => {
            cancelled();
            reject(draft.signal?.reason);
          },
          { once: true },
        );
      });
    const session = create();
    await session.start();
    const thread = events.find((event) => event.type === "thread");
    if (thread?.type !== "thread") throw new Error("Missing thread");
    expect(existsSync(thread.threadId)).toBe(false);
    await session.control("stop");
    expect(cancelled).toHaveBeenCalledOnce();
    expect(existsSync(thread.threadId)).toBe(true);
    expect(events.filter((event) => event.type === "status")).toEqual([
      { type: "status", status: "stopped" },
    ]);
    context.resumeThreadId = thread.threadId;
    context.prompt = "after stop";
    events.length = 0;
    await create().start();
    await vi.waitFor(() => expect(completed(events)).toBe(true));
    expect(events).toContainEqual({
      type: "thread",
      threadId: thread.threadId,
    });
    expect(events.some((event) => event.type === "error")).toBe(false);
  });
  it("does not display a queued question whose native timeout already elapsed", async () => {
    const { create, context, events } = await setup("queued-timed-dialog");
    const answer = deferred<UserInputDecision>();
    const request = vi.fn(() => answer.promise);
    context.requestUserInput = request;
    await create().start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(request).toHaveBeenCalledOnce();
    answer.resolve({
      inputRequestId: "first",
      content: "answer",
      answeredAt: "now",
    });
    await vi.waitFor(() => expect(completed(events)).toBe(true));
    expect(request).toHaveBeenCalledOnce();
    expect(
      events.some(
        (event) =>
          event.type === "activity" &&
          event.label.includes("input request failed"),
      ),
    ).toBe(false);
  });
  it.each([false, true])(
    "persists the last native snapshot after forced close interrupts a slow stop handler (snapshot RPC hangs=%s)",
    async (snapshotHangs) => {
      const { create, context, events, log } = await setup("dialog:slow");
      context.env.PI_TEST_HANG_SHUTDOWN = "1";
      if (snapshotHangs) context.env.PI_TEST_NO_STATE_SNAPSHOT = "1";
      context.requestUserInput = async () => new Promise(() => {});
      const session = create();
      await session.start();
      const thread = events.find((event) => event.type === "thread");
      if (thread?.type !== "thread") throw new Error("Missing thread");
      const started = Date.now();
      const stopping = session.control("stop");
      await new Promise((resolve) => setTimeout(resolve, 1550));
      const closed = session.close();
      await closed;
      await stopping;
      expect(Date.now() - started).toBeLessThan(3500);
      const saved = (await readFile(thread.threadId, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(saved[0]).toMatchObject({
        type: "session",
        id: "native-id",
        cwd: context.cwd,
      });
      expect(saved).toContainEqual(
        expect.objectContaining({
          type: "custom",
          id: "slow-state",
          data: "native-entry",
        }),
      );
      delete context.env.PI_TEST_HANG_SHUTDOWN;
      delete context.env.PI_TEST_NO_STATE_SNAPSHOT;
      context.resumeThreadId = thread.threadId;
      context.prompt = "first conversation after forced stop";
      events.length = 0;
      await create().start();
      await vi.waitFor(() => expect(completed(events)).toBe(true));
      expect(events).toContainEqual({
        type: "thread",
        threadId: thread.threadId,
      });
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(
        (await log()).filter(
          (command) =>
            command.message === "first conversation after forced stop",
        ),
      ).toHaveLength(1);
    },
  );
  it("lets the native process make its final exclusive file write before snapshot fallback", async () => {
    const { create, context, events } = await setup("handled-empty");
    context.env.PI_TEST_EXIT_PERSIST = "1";
    await create().start();
    await vi.waitFor(() => expect(completed(events)).toBe(true));
    const thread = events.find((event) => event.type === "thread");
    if (thread?.type !== "thread") throw new Error("Missing thread");
    const saved = (await readFile(thread.threadId, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(saved.at(-1)?.message).toMatchObject({
      role: "user",
      content: [{ text: "native exit conversation" }],
    });
    expect(events.some((event) => event.type === "error")).toBe(false);
  });
  it("exposes unexpected user-input failures with the question title", async () => {
    const { create, context, events } = await setup("dialog:input");
    context.requestUserInput = async () => {
      throw new Error("tracker unavailable");
    };
    await create().start();
    await vi.waitFor(() => expect(completed(events)).toBe(true));
    expect(events).toContainEqual({
      type: "activity",
      kind: "system",
      label:
        "Pi input request failed (Extension question): tracker unavailable. Retry the extension command.",
    });
  });
  it.each([false, true])(
    "gates actual writes through Roam approval: approved=%s",
    async (approved) => {
      const { create, context, cwd, events } = await setup("write");
      const request = vi.fn(async () => ({
        approvalId: "a1",
        approved,
        signedAt: "2026-11-15T00:00:00.000Z",
      }));
      context.requestApproval = request;
      await create().start();
      await vi.waitFor(() => expect(completed(events)).toBe(true));
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "applyPatch",
          payload: expect.objectContaining({ toolName: "write" }),
        }),
      );
      expect(existsSync(join(cwd, "result.txt"))).toBe(approved);
      expect(events.some((event) => event.type === "artifact")).toBe(approved);
    },
  );
  it("does not complete on agent_end while Pi is retrying", async () => {
    const { create, events } = await setup("retry");
    await create().start();
    await vi.waitFor(() => expect(completed(events)).toBe(true));
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "assistantOutput",
        content: "Recovered",
      }),
    );
  });
  it("reports final provider failures and unexpected child exits", async () => {
    for (const prompt of ["failure", "crash"]) {
      const { create, events } = await setup(prompt);
      await create().start();
      await vi.waitFor(() =>
        expect(events).toContainEqual({ type: "status", status: "failed" }),
      );
      expect(completed(events)).toBe(false);
      expect(events.some((event) => event.type === "error")).toBe(true);
    }
  });
  it("clears queued work before aborting and publishes stopped only once", async () => {
    const { create, log, events } = await setup("wait");
    const session = create();
    await session.start();
    await session.control("stop");
    expect((await log()).map((command) => command.type).slice(-2)).toEqual([
      "clear_queue",
      "abort",
    ]);
    expect(
      events.filter(
        (event) => event.type === "status" && event.status === "stopped",
      ),
    ).toHaveLength(1);
  });
  it("stops during approval without executing a late affirmative decision", async () => {
    const { create, context, cwd, events, log } = await setup("write");
    const decision = deferred<ApprovalDecision>();
    const request = vi.fn(() => decision.promise);
    context.requestApproval = request;
    const session = create();
    await session.start();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await session.control("stop");
    decision.resolve({
      approvalId: "a1",
      approved: true,
      signedAt: "2026-11-15T00:00:00.000Z",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const commands = await log();
    expect(
      commands.filter((command) => command.type === "extension_ui_response"),
    ).toMatchObject([{ id: "approval-1", cancelled: true }]);
    expect(commands.slice(-2).map((command) => command.type)).toEqual([
      "clear_queue",
      "abort",
    ]);
    expect(existsSync(join(cwd, "result.txt"))).toBe(false);
    expect(events.some((event) => event.type === "artifact")).toBe(false);
    expect(
      events.filter(
        (event) => event.type === "status" && event.status === "stopped",
      ),
    ).toHaveLength(1);
  });
  it("sends image data and applies provider-qualified model and thinking settings", async () => {
    const { create, context, log, cwd, events } = await setup();
    const image = join(cwd, "test.png");
    await writeFile(image, Buffer.from("image"));
    context.attachments = [
      {
        kind: "image",
        name: "test.png",
        localPath: image,
        mimeType: "image/png",
      },
    ];
    context.session.agentRuntimeConfig = {
      model: "custom%2Fprovider/org/model",
      reasoningEffort: "high",
    };
    await create().start();
    await vi.waitFor(() => expect(completed(events)).toBe(true));
    expect(
      (await log()).find((command) => command.type === "prompt").images,
    ).toEqual([
      {
        type: "image",
        data: Buffer.from("image").toString("base64"),
        mimeType: "image/png",
      },
    ]);
  });
  it("restores the same native session file and rejects a different project cwd", async () => {
    const { create, context, cwd, events } = await setup();
    await create().start();
    await vi.waitFor(() => expect(completed(events)).toBe(true));
    const thread = events.find((event) => event.type === "thread");
    if (thread?.type !== "thread") throw new Error("Missing thread");
    context.resumeThreadId = thread.threadId;
    context.prompt = "again";
    events.length = 0;
    await create().start();
    await vi.waitFor(() => expect(completed(events)).toBe(true));
    expect(events).toContainEqual({
      type: "thread",
      threadId: thread.threadId,
    });
    const other = join(cwd, "other");
    await mkdir(other);
    context.cwd = other;
    await expect(create().start()).rejects.toThrow(
      "different project directory",
    );
  });
  it("rejects failed prompt acceptance and invalid runtime settings", async () => {
    const { create, context } = await setup("reject");
    await expect(create().start()).rejects.toThrow(
      "rejected before acceptance",
    );
    context.prompt = "hello";
    context.session.agentRuntimeConfig = { reasoningEffort: "max" };
    await expect(create().start()).rejects.toThrow(
      "does not support thinking level",
    );
  });
  it("discovers multi-provider models, accurate thinking levels, and native skill insertion without changing settings", async () => {
    const { cwd, context, log } = await setup();
    const discovery = {
      profile: context.profile,
      env: context.env,
      workspace: cwd,
      basePath: cwd,
    };
    const options = await listPiRuntimeConfigOptions(discovery);
    expect(options.models.map((model) => model.value)).toEqual([
      "provider-a/model",
      "custom%2Fprovider/org/model",
    ]);
    expect(
      options.models[0]?.reasoningEfforts.map((effort) => effort.value),
    ).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
    expect(options.models[1]?.reasoningEfforts).toEqual([
      { value: "off", label: "off" },
    ]);
    expect(options.fastMode).toEqual({ kind: "unsupported", supported: false });
    expect(await listPiSkills(discovery)).toMatchObject([
      { name: "review", insertText: "/skill:review", sourceType: "project" },
      { name: "global", sourceType: "global" },
    ]);
    expect((await log()).map((command) => command.type)).toEqual([
      "get_available_models",
      "get_commands",
    ]);
    expect(existsSync(join(cwd, "native-session.jsonl"))).toBe(false);
  });
});

describe("Pi RPC user wait timing", () => {
  it("waits for child close and can force an already graceful shutdown", async () => {
    const { context } = await setup();
    const rpc = new PiRpc({
      command: fixture,
      args: ["--mode", "rpc", "--no-session"],
      cwd: context.cwd,
      env: { ...context.env, PI_TEST_HANG_SHUTDOWN: "1" },
      onEvent: () => undefined,
      onFailure: () => undefined,
    });
    const state = await rpc.request("get_state");
    const closing = rpc.close();
    const forced = rpc.close(true);
    expect(forced).toBe(closing);
    await forced;
    expect(() => process.kill(Number(state.pid), 0)).toThrow();
  });
  it("pauses request deadlines during human input and restores them after the answer", async () => {
    const { context } = await setup();
    let asked = false;
    const rpc = new PiRpc({
      command: fixture,
      args: ["--mode", "rpc", "--no-session"],
      cwd: context.cwd,
      env: context.env,
      onEvent: (event) => {
        if (
          event.type === "extension_ui_request" &&
          event.id === "transport-dialog"
        ) {
          rpc.setWaitingForUser(true);
          asked = true;
        }
      },
      onFailure: () => undefined,
    });
    try {
      await rpc.request("get_state");
      let settled = false;
      const pending = rpc.request("wait_for_user", {}, 100);
      void pending
        .finally(() => {
          settled = true;
        })
        .catch(() => undefined);
      await vi.waitFor(() => expect(asked).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(settled).toBe(false);
      rpc.send({
        type: "extension_ui_response",
        id: "transport-dialog",
        value: "中文回答",
      });
      rpc.setWaitingForUser(false);
      await expect(pending).resolves.toEqual({ accepted: true });
      await expect(rpc.request("never_respond", {}, 30)).rejects.toThrow(
        "timed out",
      );
    } finally {
      rpc.close();
    }
  });
});

describe("Pi execution guard", () => {
  it("does not serialize already persisted native history for the readiness seed", async () => {
    const { cwd } = await setup();
    const path = join(cwd, "persisted.jsonl");
    await writeFile(path, "persisted native history\n");
    vi.stubEnv("ROAMCLI_PI_APPROVAL_TOKEN", "test-token");
    const handlers = new Map<string, Function>();
    approvalExtension({
      registerCommand: vi.fn(),
      on: (event: string, handler: Function) => {
        handlers.set(event, handler);
      },
    });
    const notify = vi.fn();
    const getEntries = vi.fn(() => {
      throw new Error("Persisted history must stay in Pi");
    });
    const ctx = {
      sessionManager: { getSessionFile: () => path, getEntries },
      ui: { notify },
    };
    handlers.get("session_start")!({}, ctx);
    handlers.get("session_shutdown")!({}, ctx);
    expect(getEntries).not.toHaveBeenCalled();
    expect(notify.mock.calls.map((call) => call[0])).toEqual([
      "roamcli-ready:test-token",
    ]);
  });
  it.each(["strict", "standard", "trusted"])(
    "uses the approved tool policy for %s",
    async (profile) => {
      vi.stubEnv("ROAMCLI_PI_PROFILE", profile);
      vi.stubEnv("ROAMCLI_PI_APPROVAL_TOKEN", "test-token");
      const handlers = new Map<string, Function>();
      approvalExtension({
        registerCommand: vi.fn(),
        on: (event: string, handler: Function) => {
          handlers.set(event, handler);
        },
      });
      const confirm = vi.fn(async () => false);
      const ctx = { hasUI: true, ui: { confirm, notify: vi.fn() } };
      const call = handlers.get("tool_call")!;
      for (const toolName of ["read", "grep", "find", "ls"])
        expect(await call({ toolName, input: {} }, ctx)).toBeUndefined();
      for (const toolName of [
        "bash",
        "powershell",
        "write",
        "edit",
        "custom-tool",
      ]) {
        expect(await call({ toolName, input: {} }, ctx)).toEqual(
          profile === "trusted"
            ? undefined
            : { block: true, reason: "Denied by RoamCli approval" },
        );
      }
      expect(confirm).toHaveBeenCalledTimes(profile === "trusted" ? 0 : 5);
    },
  );
  it("denies tools when the UI fails and allows an affirmative decision", async () => {
    vi.stubEnv("ROAMCLI_PI_PROFILE", "standard");
    vi.stubEnv("ROAMCLI_PI_APPROVAL_TOKEN", "test-token");
    const handlers = new Map<string, Function>();
    approvalExtension({
      registerCommand: vi.fn(),
      on: (event: string, handler: Function) => {
        handlers.set(event, handler);
      },
    });
    const call = handlers.get("tool_call")!;
    expect(
      await call(
        { toolName: "bash", input: {} },
        {
          hasUI: true,
          ui: {
            confirm: async () => {
              throw new Error("broken");
            },
          },
        },
      ),
    ).toMatchObject({ block: true });
    expect(
      await call(
        { toolName: "bash", input: {} },
        { hasUI: true, ui: { confirm: async () => true } },
      ),
    ).toBeUndefined();
  });
  it("resolves npm Windows shims to Node without a shell", async () => {
    const { cwd } = await setup();
    const root = join(
      cwd,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ bin: { pi: "cli.js" } }),
    );
    await writeFile(join(root, "cli.js"), "");
    expect(piInvocation("pi", { PATH: cwd }, "win32")).toEqual({
      command: process.execPath,
      args: [join(root, "cli.js")],
    });
  });
});
