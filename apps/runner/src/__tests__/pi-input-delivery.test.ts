import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { RunnerEvent, Session } from "@roamcli/shared/protocol";
import { loadAgentRegistry } from "../agents/registry.js";
import { InputDeliveryStore } from "../persistence/input-deliveries.js";
import { StartDeliveryStore } from "../persistence/start-deliveries.js";
import { SessionManager } from "../sessions/manager.js";
import { piAgent } from "@roamcli/agent-pi";

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const path of temporary.splice(0)) {
    await rm(path, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 50,
    });
  }
});

it.each(["direct", "durable"])(
  "waits for stop cleanup before a %s continuation",
  async (mode) => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-pi-stop-resume-"));
    temporary.push(workspace);
    const events: RunnerEvent[] = [];
    let releaseStop!: () => void;
    const stopped = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    let created = 0;
    let resumedThread: string | undefined;
    const manager = new SessionManager({
      workspace,
      profile: "trusted",
      agents: [
        {
          capability: piAgent.buildCapability({ profile: "trusted", env: {} }),
          definition: {
            ...piAgent,
            createSession: (context) => {
              const sequence = ++created;
              return {
                start: async () => {
                  if (sequence > 1) {
                    resumedThread = context.resumeThreadId;
                    await context.emit({ type: "status", status: "completed" });
                  }
                },
                deliverInput: async () => undefined,
                control: async (signal) => {
                  if (signal === "stop") {
                    await stopped;
                    await context.emit({ type: "status", status: "stopped" });
                  }
                },
                close: async () => undefined,
              };
            },
          },
        },
      ],
      emit: (event) => {
        events.push(event);
      },
    });
    const session: Session = {
      id: "pi-stop-resume",
      projectId: "p1",
      runnerId: "r1",
      title: "Pi stop resume",
      agent: "pi",
      status: "pending",
      executionMode: "direct",
      executionFolder: workspace,
      cwd: workspace,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    let restarting: Promise<void> | undefined;
    try {
      await manager.start(session, "wait");
      const storeReads = vi.spyOn(StartDeliveryStore.prototype, "get");
      manager.control(session.id, "stop");
      let resumed = false;
      restarting = (
        mode === "durable"
          ? manager.handle({
              type: "startSession",
              requestId: "resume-request",
              deliveryId: "resume-delivery",
              session,
              prompt: "continue",
              resumeThreadId: "native-thread",
              attachments: [],
            })
          : manager.start(session, "continue", "native-thread")
      ).then(() => {
        resumed = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (mode === "durable") expect(storeReads).not.toHaveBeenCalled();
      expect(resumed).toBe(false);
      releaseStop();
      await restarting;
      expect(created).toBe(2);
      expect(resumedThread).toBe("native-thread");
      expect(
        events.some(
          (event) => event.type === "error" && event.code === "SESSION_EXISTS",
        ),
      ).toBe(false);
    } finally {
      vi.restoreAllMocks();
      releaseStop();
      await restarting?.catch(() => undefined);
      manager.control(session.id, "stop");
    }
  },
);

it("retries an explicit Pi refusal through Runner and persists only accepted ownership", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "roam-pi-input-retry-"));
  temporary.push(workspace);
  const stateDir = join(workspace, ".runner-state");
  const log = join(workspace, "rpc.jsonl");
  vi.stubEnv(
    "ROAMCLI_AGENT_PI_COMMAND",
    fileURLToPath(
      new URL(
        "../../../../packages/agent-pi/test/fixtures/pi-rpc.mjs",
        import.meta.url,
      ),
    ),
  );
  vi.stubEnv("PI_TEST_LOG", log);
  const registry = await loadAgentRegistry("trusted", ["@roamcli/agent-pi"]);
  const events: RunnerEvent[] = [];
  const manager = new SessionManager({
    workspace,
    stateDir,
    profile: "trusted",
    agents: registry.agents,
    emit: (event) => {
      events.push(event);
    },
  });
  const session: Session = {
    id: "pi-retry",
    projectId: "p1",
    runnerId: "r1",
    title: "Pi retry",
    agent: "pi",
    status: "pending",
    executionMode: "direct",
    executionFolder: workspace,
    cwd: workspace,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const delivery = {
    type: "checkSessionStatus" as const,
    sessionId: session.id,
    deliverInput: { deliveryId: "retry-once-id", content: "reject-once" },
  };
  try {
    await manager.start(session, "wait");
    await manager.handle({ ...delivery, requestId: "refused" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "sessionStatusCheckResult",
        result: expect.objectContaining({
          requestId: "refused",
          inputReceipt: { deliveryId: "retry-once-id", ownership: "not_owned" },
        }),
      }),
    );
    expect(
      await new InputDeliveryStore(stateDir).get("retry-once-id"),
    ).toBeUndefined();

    await manager.handle({ ...delivery, requestId: "retried" });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "sessionStatusCheckResult",
        result: expect.objectContaining({
          requestId: "retried",
          inputReceipt: { deliveryId: "retry-once-id", ownership: "owned" },
        }),
      }),
    );
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: "sessionStatus",
        sessionId: session.id,
        status: "completed",
      }),
    );
    expect(
      await new InputDeliveryStore(stateDir).get("retry-once-id"),
    ).toMatchObject({ ownership: "owned" });

    const restartedEvents: RunnerEvent[] = [];
    const restarted = new SessionManager({
      workspace,
      stateDir,
      profile: "trusted",
      agents: registry.agents,
      emit: (event) => {
        restartedEvents.push(event);
      },
    });
    await restarted.handle({ ...delivery, requestId: "after-restart" });
    expect(restartedEvents).toContainEqual(
      expect.objectContaining({
        type: "sessionStatusCheckResult",
        result: expect.objectContaining({
          requestId: "after-restart",
          inputReceipt: { deliveryId: "retry-once-id", ownership: "owned" },
        }),
      }),
    );
    const commands = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      commands.filter(
        (command) =>
          command.type === "prompt" && command.message === "reject-once",
      ),
    ).toHaveLength(2);
  } finally {
    manager.control(session.id, "stop");
  }
});
