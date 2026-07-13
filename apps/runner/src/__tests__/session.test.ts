import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AgentInputUnavailableError,
  AgentInput,
  type AgentSession,
  type AgentSessionContext,
} from "@roamcli/agent-plugin-sdk";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  type RunnerEvent,
  type Session,
} from "@roamcli/shared/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAgentRegistry, type LoadedAgent } from "../agents/registry.js";
import { StartDeliveryStore } from "../persistence/start-deliveries.js";
import { SessionManager } from "../sessions/manager.js";

const execFileAsync = promisify(execFile);

describe("SessionManager", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("persists durable start ownership and deduplicates a retried command", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-start-delivery-"),
    );
    const events: RunnerEvent[] = [];
    const tracked = startCountingCodexAgent();
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [tracked.agent],
      emit: (event) => {
        events.push(event);
      },
    });
    const command = {
      type: "startSession" as const,
      requestId: "start-request-1",
      deliveryId: "start-delivery-1",
      session: makeSession(workspace),
      prompt: "start once",
      attachments: [],
    };

    await manager.handle(command);
    await manager.handle({ ...command, requestId: "start-request-retry" });
    await manager.handle({
      ...command,
      requestId: "start-request-conflict",
      prompt: "different prompt",
    });

    expect(tracked.created()).toBe(1);
    expect(events).toContainEqual({
      type: "sessionStartResult",
      result: {
        requestId: "start-request-retry",
        sessionId: "s1",
        deliveryId: "start-delivery-1",
        ownership: "owned",
      },
    });
    expect(events).toContainEqual({
      type: "error",
      requestId: "start-request-conflict",
      sessionId: "s1",
      message:
        "Start delivery payload conflicts with an existing receipt: start-delivery-1",
      code: "START_DELIVERY_CONFLICT",
    });
  });

  it.each(["accepted", "launching", "launched"] as const)(
    "does not autonomously replay a prior-boot %s intent",
    async (state) => {
      const workspace = await mkdtemp(
        join(tmpdir(), "roam-runner-start-recovery-"),
      );
      const stateDir = join(workspace, ".runner-state");
      const session = makeSession(workspace);
      await new StartDeliveryStore(stateDir).put({
        deliveryId: `delivery-${state}`,
        payloadHash: "persisted-hash",
        payload: {
          requestId: `request-${state}`,
          session,
          prompt: "recover me",
          attachments: [],
        },
        state,
        ...(state === "launching" || state === "launched"
          ? { bootId: "crashed-boot" }
          : {}),
      });
      const events: RunnerEvent[] = [];
      const tracked = startCountingCodexAgent();
      new SessionManager({
        workspace,
        stateDir,
        profile: "standard",
        agents: [tracked.agent],
        emit: (event) => {
          events.push(event);
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(tracked.created()).toBe(0);
      expect(events).toEqual([]);
    },
  );

  it.each([
    { state: "launching" as const, ownership: "not_owned" as const },
    { state: "launched" as const, ownership: "owned" as const },
  ])(
    "returns $ownership without replaying an explicitly retried prior-boot $state intent",
    async ({ state, ownership }) => {
      const workspace = await mkdtemp(
        join(tmpdir(), "roam-runner-start-indeterminate-"),
      );
      const stateDir = join(workspace, ".runner-state");
      const first = startCountingCodexAgent();
      const firstManager = new SessionManager({
        workspace,
        stateDir,
        profile: "standard",
        agents: [first.agent],
        emit: () => undefined,
      });
      const command = {
        type: "startSession" as const,
        requestId: "request-indeterminate",
        deliveryId: "delivery-indeterminate",
        session: makeSession(workspace),
        prompt: "start once",
        attachments: [],
      };
      await firstManager.handle(command);
      await new Promise((resolve) => setTimeout(resolve, 25));
      const receiptPath = join(stateDir, "start-delivery-receipts.json");
      const document = JSON.parse(await readFile(receiptPath, "utf8")) as {
        receipts: Array<Record<string, unknown>>;
      };
      document.receipts[0] = {
        ...document.receipts[0],
        state,
        bootId: "crashed-boot",
      };
      await writeFile(receiptPath, `${JSON.stringify(document)}\n`, {
        mode: 0o600,
      });

      const events: RunnerEvent[] = [];
      const restarted = startCountingCodexAgent();
      const restartedManager = new SessionManager({
        workspace,
        stateDir,
        profile: "standard",
        agents: [restarted.agent],
        emit: (event) => {
          events.push(event);
        },
      });
      await restartedManager.handle({
        ...command,
        requestId: "request-indeterminate-retry",
      });

      expect(restarted.created()).toBe(0);
      expect(events).toContainEqual({
        type: "sessionStartResult",
        result: {
          requestId: "request-indeterminate-retry",
          sessionId: "s1",
          deliveryId: "delivery-indeterminate",
          ownership,
        },
      });
    },
  );

  it("launches an accepted intent only after the server explicitly retries it", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-start-accepted-retry-"),
    );
    const stateDir = join(workspace, ".runner-state");
    const command = {
      type: "startSession" as const,
      requestId: "request-accepted",
      deliveryId: "delivery-accepted",
      session: makeSession(workspace),
      prompt: "authorized retry",
      attachments: [],
    };
    const seed = startCountingCodexAgent();
    await new SessionManager({
      workspace,
      stateDir,
      profile: "standard",
      agents: [seed.agent],
      emit: () => undefined,
    }).handle(command);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const receiptPath = join(stateDir, "start-delivery-receipts.json");
    const document = JSON.parse(await readFile(receiptPath, "utf8")) as {
      receipts: Array<Record<string, unknown>>;
    };
    document.receipts[0] = {
      ...document.receipts[0],
      state: "accepted",
    };
    delete document.receipts[0]!.bootId;
    await writeFile(receiptPath, `${JSON.stringify(document)}\n`, {
      mode: 0o600,
    });

    const tracked = startCountingCodexAgent();
    const manager = new SessionManager({
      workspace,
      stateDir,
      profile: "standard",
      agents: [tracked.agent],
      emit: () => undefined,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(tracked.created()).toBe(0);

    await manager.handle({ ...command, requestId: "request-accepted-retry" });
    expect(tracked.created()).toBe(1);
  });

  it("does not recover a completed start receipt from an earlier boot", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-start-completed-"),
    );
    const stateDir = join(workspace, ".runner-state");
    await new StartDeliveryStore(stateDir).put({
      deliveryId: "delivery-completed",
      payloadHash: "persisted-hash",
      payload: {
        requestId: "request-completed",
        session: makeSession(workspace),
        prompt: "do not recover",
        attachments: [],
      },
      state: "completed",
      bootId: "prior-boot",
    });
    const tracked = startCountingCodexAgent();
    new SessionManager({
      workspace,
      stateDir,
      profile: "standard",
      agents: [tracked.agent],
      emit: () => undefined,
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(tracked.created()).toBe(0);
  });

  it("handles a fast agent start rejection without an unhandled rejection", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-start-rejection-"),
    );
    const base = longRunningCodexAgent();
    const agent: LoadedAgent = {
      ...base,
      definition: {
        ...base.definition,
        createSession(context) {
          return new TestAgentSession(context, async () => {
            throw new Error("prompt rejected");
          });
        },
      },
    };
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    let releasePersistence!: () => void;
    const persistence = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [agent],
      emit: () => undefined,
    });
    try {
      const started = manager.start(
        makeSession(workspace),
        "reject",
        undefined,
        [],
        () => persistence,
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(unhandled).toEqual([]);
      releasePersistence();
      await started;
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("returns not-owned and releases later commands when start acceptance hangs", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-start-acceptance-timeout-"),
    );
    const events: RunnerEvent[] = [];
    let closed = 0;
    const base = longRunningCodexAgent();
    const agent: LoadedAgent = {
      ...base,
      definition: {
        ...base.definition,
        createSession(context) {
          return new TestAgentSession(
            context,
            () => new Promise<void>(() => undefined),
            undefined,
            undefined,
            () => {
              closed += 1;
            },
          );
        },
      },
    };
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [agent],
      emit: (event) => {
        events.push(event);
      },
      agentAcceptanceTimeoutMs: 10,
    });

    await manager.handle({
      type: "startSession",
      requestId: "hung-start-request",
      deliveryId: "hung-start-delivery",
      session: makeSession(workspace),
      prompt: "hang",
      attachments: [],
    });
    await manager.handle({
      type: "checkSessionStatus",
      requestId: "after-hung-start",
      sessionId: "s1",
    });
    await manager.handle({
      type: "startSession",
      requestId: "hung-start-retry",
      deliveryId: "hung-start-delivery",
      session: makeSession(workspace),
      prompt: "hang",
      attachments: [],
    });

    expect(closed).toBe(1);
    expect(events).toContainEqual({
      type: "error",
      sessionId: "s1",
      message: "Agent start acceptance timed out",
      code: "AGENT_ACCEPTANCE_TIMEOUT",
    });
    expect(events).toContainEqual({
      type: "sessionStartResult",
      result: {
        requestId: "hung-start-request",
        sessionId: "s1",
        deliveryId: "hung-start-delivery",
        ownership: "not_owned",
      },
    });
    expect(events).toContainEqual({
      type: "sessionStatusCheckResult",
      result: {
        requestId: "after-hung-start",
        sessionId: "s1",
        active: false,
      },
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "sessionStartResult",
        result: expect.objectContaining({ ownership: "owned" }),
      }),
    );
    expect(events).toContainEqual({
      type: "sessionStartResult",
      result: {
        requestId: "hung-start-retry",
        sessionId: "s1",
        deliveryId: "hung-start-delivery",
        ownership: "not_owned",
      },
    });
  });

  it("runs the codex plugin through the process adapter and extracts codex json output", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-session-"));
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: await fakeCodexAgents(workspace),
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.start(makeSession(workspace), "hello");

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "sessionThread",
        sessionId: "s1",
        threadId: "codex-thread-1",
      });
      expect(
        events.some(
          (event) =>
            event.type === "assistantOutput" &&
            /^codex-run-[^:]+:item_1$/.test(event.outputId) &&
            (event.content ?? "").includes("codex answer: hello"),
        ),
      ).toBe(true);
      expect(events).toContainEqual({
        type: "sessionStatus",
        sessionId: "s1",
        status: "completed",
      });
    });
  });

  it("handles file tree and content commands scoped to a started codex session cwd", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-files-"),
    );
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "main.ts"), "console.log('ok');");
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: await fakeCodexAgents(workspace),
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.start(makeSession(workspace), "ready");
    await manager.handle({
      type: "readFileTree",
      requestId: "tree1",
      sessionId: "s1",
      path: ".",
      depth: 1,
    });
    await manager.handle({
      type: "readFileContent",
      requestId: "content1",
      sessionId: "s1",
      path: "src/main.ts",
      maxBytes: 7,
    });
    await manager.handle({
      type: "writeFileContent",
      requestId: "write1",
      sessionId: "s1",
      path: "src/main.ts",
      content: "console.log('saved');",
    });

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "fileTreeResult",
        result: expect.objectContaining({
          requestId: "tree1",
          sessionId: "s1",
        }),
      }),
    );
    expect(events).toContainEqual({
      type: "fileContentResult",
      result: {
        requestId: "content1",
        sessionId: "s1",
        path: "src/main.ts",
        kind: "text",
        content: "console",
        truncated: true,
        encoding: "utf8",
      },
    });
    expect(events).toContainEqual({
      type: "fileWriteResult",
      result: {
        requestId: "write1",
        sessionId: "s1",
        path: "src/main.ts",
        bytesWritten: 21,
        encoding: "utf8",
      },
    });
    await expect(
      readFile(join(workspace, "src", "main.ts"), "utf8"),
    ).resolves.toBe("console.log('saved');");
  });

  it("creates managed git worktrees and scopes the session to the execution folder", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-worktree-"),
    );
    await writeFile(join(workspace, "README.md"), "hello\n", "utf8");
    await git(workspace, ["init"]);
    await git(workspace, ["config", "user.email", "test@example.com"]);
    await git(workspace, ["config", "user.name", "Test User"]);
    await git(workspace, ["add", "README.md"]);
    await git(workspace, ["commit", "-m", "init"]);
    const executionFolder = join(workspace, ".roamcli-worktrees", "s1");
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: await fakeCodexAgents(workspace),
      emit: (event) => {
        events.push(event);
      },
    });

    const managedSession: Session = {
      ...makeSession(workspace),
      executionMode: "managed_worktree",
      executionFolder,
      cwd: workspace,
      gitBranchName: "roam/test-worktree",
      gitBaseRef: "HEAD",
    };

    await manager.start(managedSession, "managed");
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "sessionStatus",
        sessionId: "s1",
        status: "completed",
      });
    });
    await manager.handle({
      type: "readFileContent",
      requestId: "content1",
      sessionId: "s1",
      cwd: executionFolder,
      path: "README.md",
      maxBytes: 256,
    });

    await expect(
      readFile(join(executionFolder, "README.md"), "utf8"),
    ).resolves.toBe("hello\n");
    expect(events).toContainEqual({
      type: "fileContentResult",
      result: {
        requestId: "content1",
        sessionId: "s1",
        path: "README.md",
        kind: "text",
        content: "hello\n",
        truncated: false,
        encoding: "utf8",
      },
    });

    events.length = 0;
    await manager.start(managedSession, "resume managed", "codex-thread-1");
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "sessionThread",
        sessionId: "s1",
        threadId: "codex-thread-resumed",
      });
      expect(events).toContainEqual({
        type: "sessionStatus",
        sessionId: "s1",
        status: "completed",
      });
    });
    expect(
      events.some(
        (event) => event.type === "error" && event.code === "SPAWN_ERROR",
      ),
    ).toBe(false);
  });

  it("rejects an existing managed worktree folder that is not a registered git worktree", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-invalid-worktree-"),
    );
    await writeFile(join(workspace, "README.md"), "hello\n", "utf8");
    await git(workspace, ["init"]);
    await git(workspace, ["config", "user.email", "test@example.com"]);
    await git(workspace, ["config", "user.name", "Test User"]);
    await git(workspace, ["add", "README.md"]);
    await git(workspace, ["commit", "-m", "init"]);
    const executionFolder = join(workspace, ".roamcli-worktrees", "s1");
    await mkdir(executionFolder, { recursive: true });
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: await fakeCodexAgents(workspace),
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.start(
      {
        ...makeSession(workspace),
        executionMode: "managed_worktree",
        executionFolder,
        cwd: workspace,
      },
      "managed",
    );

    expect(events).toContainEqual({
      type: "error",
      sessionId: "s1",
      message: `Managed worktree path is not registered for the project: ${await realpath(executionFolder)}`,
      code: "INVALID_CWD",
    });
  });

  it("rejects a direct session cwd symlink that escapes the workspace", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-link-workspace-"),
    );
    const outside = await mkdtemp(
      join(tmpdir(), "roam-runner-session-link-outside-"),
    );
    const linkedCwd = join(workspace, "linked-project");
    await symlink(outside, linkedCwd);
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [longRunningCodexAgent()],
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.start(
      {
        ...makeSession(workspace),
        cwd: linkedCwd,
        executionFolder: linkedCwd,
      },
      "blocked",
    );

    expect(events).toContainEqual({
      type: "error",
      sessionId: "s1",
      message: `Path escapes workspace: ${linkedCwd}`,
      code: "INVALID_CWD",
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "sessionStatus", status: "running" }),
    );
  });

  it("rejects a managed worktree whose symlinked parent escapes the workspace", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-worktree-link-workspace-"),
    );
    const outside = await mkdtemp(
      join(tmpdir(), "roam-runner-worktree-link-outside-"),
    );
    await writeFile(join(workspace, "README.md"), "root\n", "utf8");
    await git(workspace, ["init"]);
    await git(workspace, ["config", "user.email", "test@example.com"]);
    await git(workspace, ["config", "user.name", "Test User"]);
    await git(workspace, ["add", "README.md"]);
    await git(workspace, ["commit", "-m", "init"]);
    const worktreeParent = join(workspace, ".roamcli-worktrees");
    const executionFolder = join(worktreeParent, "s1");
    await symlink(outside, worktreeParent);
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [longRunningCodexAgent()],
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.start(
      {
        ...makeSession(workspace),
        executionMode: "managed_worktree",
        executionFolder,
        gitBranchName: "roam/escaped-worktree",
      },
      "blocked",
    );

    expect(events).toContainEqual({
      type: "error",
      sessionId: "s1",
      message: `Path escapes workspace: ${executionFolder}`,
      code: "INVALID_CWD",
    });
    await expect(stat(join(outside, "s1"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recovers file command cwd from the command payload when the session is not cached", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-session-cwd-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "main.ts"), "console.log('ok');");
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: await fakeCodexAgents(workspace),
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.handle({
      type: "readFileContent",
      requestId: "content1",
      sessionId: "s1",
      cwd: workspace,
      path: "src/main.ts",
      maxBytes: 7,
    });

    expect(events).toContainEqual({
      type: "fileContentResult",
      result: {
        requestId: "content1",
        sessionId: "s1",
        path: "src/main.ts",
        kind: "text",
        content: "console",
        truncated: true,
        encoding: "utf8",
      },
    });
  });

  it("does not promote a one-off browse cwd into an active writable session scope", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-browse-scope-"),
    );
    await writeFile(join(workspace, "README.md"), "original", "utf8");
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [longRunningCodexAgent()],
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.handle({
      type: "readFileContent",
      requestId: "browse-read",
      sessionId: "browse-only",
      cwd: workspace,
      path: "README.md",
      maxBytes: 256,
    });
    events.length = 0;
    await manager.handle({
      type: "writeFileContent",
      requestId: "browse-write",
      sessionId: "browse-only",
      path: "README.md",
      content: "overwritten",
    });

    expect(events).toContainEqual({
      type: "error",
      requestId: "browse-write",
      sessionId: "browse-only",
      message: "Session cwd is unavailable",
      code: "SESSION_NOT_FOUND",
    });
    await expect(readFile(join(workspace, "README.md"), "utf8")).resolves.toBe(
      "original",
    );
  });

  it("clears implicit writable scope while allowing explicit terminal-session workspace commands", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-scope-cleanup-"),
    );
    await writeFile(join(workspace, "README.md"), "original", "utf8");
    await writeFile(join(workspace, "PATCH.md"), "old\n", "utf8");
    const events: RunnerEvent[] = [];
    const controlledAgent = controlledCompletionCodexAgent();
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [controlledAgent.agent],
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.start(makeSession(workspace), "wait");
    await controlledAgent.complete();
    events.length = 0;
    await manager.handle({
      type: "writeFileContent",
      requestId: "write-after-complete",
      sessionId: "s1",
      path: "README.md",
      content: "overwritten",
    });

    expect(events).toContainEqual({
      type: "error",
      requestId: "write-after-complete",
      sessionId: "s1",
      message: "Session cwd is unavailable",
      code: "SESSION_NOT_FOUND",
    });
    await expect(readFile(join(workspace, "README.md"), "utf8")).resolves.toBe(
      "original",
    );

    events.length = 0;
    await manager.handle({
      type: "applyPatch",
      requestId: "patch-after-complete",
      sessionId: "s1",
      cwd: workspace,
      patch: [
        "diff --git a/PATCH.md b/PATCH.md",
        "--- a/PATCH.md",
        "+++ b/PATCH.md",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "",
      ].join("\n"),
      strip: 1,
    });

    expect(events).toContainEqual({
      type: "patchApplyResult",
      result: {
        requestId: "patch-after-complete",
        sessionId: "s1",
        applied: true,
        changedFiles: ["PATCH.md"],
        message: "applied",
        rejected: [],
      },
    });
    await expect(readFile(join(workspace, "PATCH.md"), "utf8")).resolves.toBe(
      "new\n",
    );
  });

  it("reports command cwd resolution errors instead of hiding them as missing sessions", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-invalid-cwd-"),
    );
    const outsideWorkspace = join(tmpdir(), "roam-runner-outside-project");
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: await fakeCodexAgents(workspace),
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.handle({
      type: "readFileTree",
      requestId: "tree1",
      sessionId: "project-directory-check",
      cwd: outsideWorkspace,
      path: ".",
      depth: 0,
    });

    expect(events).toContainEqual({
      type: "error",
      requestId: "tree1",
      sessionId: "project-directory-check",
      message: `Path escapes workspace: ${outsideWorkspace}`,
      code: "INVALID_CWD",
    });
  });

  it("returns request-scoped errors for file commands without cwd context", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-missing-cwd-"),
    );
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: await fakeCodexAgents(workspace),
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.handle({
      type: "readFileTree",
      requestId: "tree1",
      sessionId: "missing",
      path: ".",
      depth: 1,
    });

    expect(events).toContainEqual({
      type: "error",
      requestId: "tree1",
      sessionId: "missing",
      message: "Session cwd is unavailable",
      code: "SESSION_NOT_FOUND",
    });
  });

  it("emits failed git jobs when mutation cwd resolution fails", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-git-cwd-"),
    );
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: await fakeCodexAgents(workspace),
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.handle({
      type: "gitStagePaths",
      requestId: "git-stage-1",
      projectId: "project-1",
      cwd: "../outside",
      context: { kind: "project", projectId: "project-1" },
      paths: ["README.md"],
    });

    expect(events).toContainEqual({
      type: "gitJobResult",
      job: expect.objectContaining({
        id: "git-stage-1",
        projectId: "project-1",
        contextKind: "project",
        operation: "stage",
        status: "failed",
        errorCode: "GIT_OPERATION_ERROR",
        errorSummary: "Path escapes workspace: ../outside",
      }),
    });
  });

  it("resolves plugin-emitted artifact paths inside the started codex session cwd", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-artifact-"),
    );
    const sessionCwd = join(workspace, "task");
    await mkdir(sessionCwd, { recursive: true });
    await writeFile(join(sessionCwd, "result.log"), "artifact output", "utf8");
    const artifactStoragePath = await realpath(join(sessionCwd, "result.log"));
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [artifactCodexAgent()],
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.start(makeSession(sessionCwd), "ready");

    await vi.waitFor(() => {
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "artifactCreated",
          artifact: expect.objectContaining({
            sessionId: "s1",
            name: "result.log",
            mimeType: "text/plain",
            storagePath: artifactStoragePath,
          }),
        }),
      );
    });
    expect(
      events.some(
        (event) => event.type === "error" && event.code === "ARTIFACT_ERROR",
      ),
    ).toBe(false);
  });

  it("drops a fire-and-forget approval that races with terminal completion", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-stale-approval-"),
    );
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [approvalCodexAgent()],
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.start(makeSession(workspace), "approval please");
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "sessionStatus",
        sessionId: "s1",
        status: "completed",
      });
    });
    await Promise.resolve();
    await Promise.resolve();

    const statusEvents = events.filter(
      (event) => event.type === "sessionStatus",
    );
    expect(statusEvents.at(-1)).toEqual({
      type: "sessionStatus",
      sessionId: "s1",
      status: "completed",
    });
    expect(events.some((event) => event.type === "approvalRequested")).toBe(
      false,
    );
    expect(statusEvents.at(-1)?.status).toBe("completed");
  });

  it("emits one-shot process exit status after delayed approval output handling", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-approval-order-"),
    );
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [approvalCodexAgent()],
      emit: async (event) => {
        if (
          event.type === "sessionStatus" &&
          event.status === "waiting_approval"
        ) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        events.push(event);
      },
    });

    await manager.start(makeSession(workspace), "approval please");

    await vi.waitFor(() => {
      const statusEvents = events.filter(
        (event) => event.type === "sessionStatus",
      );
      expect(statusEvents.at(-1)).toEqual({
        type: "sessionStatus",
        sessionId: "s1",
        status: "completed",
      });
    });
  });

  it("finalizes the session when output handling rejects", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-output-error-"),
    );
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [throwingParserCodexAgent()],
      emit: (event) => {
        events.push(event);
      },
    });

    const started = manager.start(makeSession(workspace), "ready");

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "sessionStatus",
        sessionId: "s1",
        status: "completed",
      });
    });
    manager.deliverInput("s1", "late input");

    expect(events).toContainEqual({
      type: "error",
      sessionId: "s1",
      message: "Session is not running",
      code: "SESSION_NOT_RUNNING",
    });
  });

  it("reports synchronous active input failures as session-scoped agent errors", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-input-error-"),
    );
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [throwingInputCodexAgent()],
      emit: (event) => {
        events.push(event);
      },
    });

    const started = manager.start(makeSession(workspace), "ready");
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "sessionStatus",
        sessionId: "s1",
        status: "running",
      });
    });

    expect(() => manager.deliverInput("s1", "boom")).not.toThrow();

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "error",
        sessionId: "s1",
        message: "input boom",
        code: "AGENT_INPUT_ERROR",
      });
    });
    manager.control("s1", "stop");
  });

  it("reports synchronous stop control failures and still force-closes", async () => {
    vi.useFakeTimers();
    try {
      const workspace = await mkdtemp(
        join(tmpdir(), "roam-runner-session-control-error-"),
      );
      const controlAgent = throwingControlCodexAgent();
      const events: RunnerEvent[] = [];
      const manager = new SessionManager({
        workspace,
        profile: "standard",
        agents: [controlAgent.agent],
        emit: (event) => {
          events.push(event);
        },
      });

      await manager.start(makeSession(workspace), "ready");
      await vi.waitFor(() => {
        expect(events).toContainEqual({
          type: "sessionStatus",
          sessionId: "s1",
          status: "running",
        });
      });

      expect(() => manager.control("s1", "stop")).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();

      expect(
        events.some(
          (event) =>
            event.type === "error" &&
            event.sessionId === "s1" &&
            event.message === "control boom" &&
            event.code === "AGENT_CONTROL_ERROR",
        ),
      ).toBe(true);

      await vi.advanceTimersByTimeAsync(1500);

      expect(controlAgent.closed()).toBe(true);
      expect(events).toContainEqual({
        type: "sessionStatus",
        sessionId: "s1",
        status: "stopped",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("finalizes terminal sessions when terminal status emission rejects", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-terminal-error-"),
    );
    const controlledAgent = controlledCompletionCodexAgent();
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [controlledAgent.agent],
      emit: async (event) => {
        events.push(event);
        if (event.type === "sessionStatus" && event.status === "completed") {
          throw new Error("sink down");
        }
      },
    });

    await manager.start(makeSession(workspace), "ready");
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "sessionStatus",
        sessionId: "s1",
        status: "running",
      });
    });

    await expect(controlledAgent.complete()).rejects.toThrow("sink down");
    manager.deliverInput("s1", "late input");

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "error",
        sessionId: "s1",
        message: "Session is not running",
        code: "SESSION_NOT_RUNNING",
      });
    });
  });

  it("rejects approval and input requests from a terminal generation", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-terminal-generation-"),
    );
    const controlledAgent = controlledCompletionCodexAgent();
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [controlledAgent.agent],
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.start(makeSession(workspace), "ready");
    await controlledAgent.complete();
    const eventCountAtCompletion = events.length;

    await controlledAgent.emitLateRunning();
    await expect(controlledAgent.requestLateApproval()).rejects.toThrow(
      "Session ended before approval was requested",
    );
    await expect(controlledAgent.requestLateInput()).rejects.toThrow(
      "Session ended before user input was requested",
    );

    expect(events).toHaveLength(eventCountAtCompletion);
    expect(events.at(-1)).toEqual({
      type: "sessionStatus",
      sessionId: "s1",
      status: "completed",
    });
  });

  it("cleans a failed start with pending input and allows the session to restart", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-start-cleanup-"),
    );
    const lifecycleAgent = failThenRequestInputCodexAgent();
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [lifecycleAgent.agent],
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.start(makeSession(workspace), "fail first");

    expect(lifecycleAgent.closedCount()).toBe(1);
    expect(events).toContainEqual({
      type: "error",
      sessionId: "s1",
      message: "start boom",
      code: "SPAWN_ERROR",
    });
    await manager.handle({
      type: "readFileTree",
      requestId: "tree-after-failure",
      sessionId: "s1",
      path: ".",
      depth: 1,
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        requestId: "tree-after-failure",
        code: "SESSION_NOT_FOUND",
      }),
    );

    const restarted = manager.start(makeSession(workspace), "second start");
    await vi.waitFor(() => {
      expect(
        events.filter(
          (event) =>
            event.type === "agentActivity" &&
            event.inputRequestId !== undefined,
        ),
      ).toHaveLength(2);
    });
    const requests = events.filter(
      (
        event,
      ): event is Extract<RunnerEvent, { type: "agentActivity" }> & {
        inputRequestId: string;
      } => event.type === "agentActivity" && event.inputRequestId !== undefined,
    );
    await manager.handle({
      type: "resolveUserInput",
      sessionId: "s1",
      inputRequestId: requests.at(-1)!.inputRequestId,
      content: "continue",
    });
    await restarted;

    expect(events.at(-1)).toEqual({
      type: "sessionStatus",
      sessionId: "s1",
      status: "completed",
    });
  });

  it("closes an allocated agent and clears starting state when initial status emit fails", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-initial-emit-failure-"),
    );
    const closeTrackingAgent = closeTrackingCodexAgent();
    const events: RunnerEvent[] = [];
    let failInitialRunning = true;
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [closeTrackingAgent.agent],
      emit: (event) => {
        events.push(event);
        if (
          failInitialRunning &&
          event.type === "sessionStatus" &&
          event.status === "running"
        ) {
          failInitialRunning = false;
          throw new Error("initial status failed");
        }
      },
    });

    await manager.start(makeSession(workspace), "first");
    expect(closeTrackingAgent.closedCount()).toBe(1);
    await manager.handle({
      type: "checkSessionStatus",
      requestId: "after-emit-failure",
      sessionId: "s1",
    });
    expect(events).toContainEqual({
      type: "sessionStatusCheckResult",
      result: {
        requestId: "after-emit-failure",
        sessionId: "s1",
        active: false,
      },
    });

    await manager.start(makeSession(workspace), "second");
    expect(events.at(-1)).toEqual({
      type: "sessionStatus",
      sessionId: "s1",
      status: "running",
    });
    manager.control("s1", "stop");
  });

  it("reports active session liveness for status checks", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-status-check-"),
    );
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [longRunningCodexAgent()],
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.start(makeSession(workspace), "wait");
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "sessionStatus",
        sessionId: "s1",
        status: "running",
      });
    });

    await manager.handle({
      type: "checkSessionStatus",
      requestId: "check-active",
      sessionId: "s1",
    });
    await manager.handle({
      type: "checkSessionStatus",
      requestId: "check-missing",
      sessionId: "missing-session",
    });

    expect(events).toContainEqual({
      type: "sessionStatusCheckResult",
      result: {
        requestId: "check-active",
        sessionId: "s1",
        active: true,
      },
    });
    expect(events).toContainEqual({
      type: "sessionStatusCheckResult",
      result: {
        requestId: "check-missing",
        sessionId: "missing-session",
        active: false,
      },
    });

    manager.control("s1", "stop");
  });

  it("atomically delivers input while checking an active session", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-atomic-input-"),
    );
    const events: RunnerEvent[] = [];
    const delivered: string[] = [];
    let acceptDelivery!: () => void;
    const deliveryAccepted = new Promise<void>((resolve) => {
      acceptDelivery = resolve;
    });
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [deferredInputCodexAgent(delivered, deliveryAccepted)],
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.start(makeSession(workspace), "wait");
    const checked = manager.handle({
      type: "checkSessionStatus",
      requestId: "check-and-deliver",
      sessionId: "s1",
      deliverInput: { content: "continue" },
    });
    await vi.waitFor(() => expect(delivered).toEqual(["continue"]));
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "sessionStatusCheckResult",
        result: expect.objectContaining({ requestId: "check-and-deliver" }),
      }),
    );

    acceptDelivery();
    await checked;
    expect(events).toContainEqual({
      type: "sessionStatusCheckResult",
      result: {
        requestId: "check-and-deliver",
        sessionId: "s1",
        active: true,
        inputDelivered: true,
      },
    });
    manager.control("s1", "stop");
  });

  it("returns not-owned and releases later commands when input acceptance hangs", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-input-acceptance-timeout-"),
    );
    const events: RunnerEvent[] = [];
    let closed = 0;
    const base = longRunningCodexAgent();
    const agent: LoadedAgent = {
      ...base,
      definition: {
        ...base.definition,
        createSession(context) {
          return new TestAgentSession(
            context,
            undefined,
            () => new Promise<void>(() => undefined),
            undefined,
            () => {
              closed += 1;
            },
          );
        },
      },
    };
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [agent],
      emit: (event) => {
        events.push(event);
      },
      agentAcceptanceTimeoutMs: 10,
    });
    await manager.start(makeSession(workspace), "wait");

    await manager.handle({
      type: "checkSessionStatus",
      requestId: "hung-input-request",
      sessionId: "s1",
      deliverInput: {
        deliveryId: "hung-input-delivery",
        content: "hang",
      },
    });
    await manager.handle({
      type: "checkSessionStatus",
      requestId: "after-hung-input",
      sessionId: "s1",
    });
    await manager.handle({
      type: "checkSessionStatus",
      requestId: "hung-input-retry",
      sessionId: "s1",
      deliverInput: {
        deliveryId: "hung-input-delivery",
        content: "hang",
      },
    });

    expect(closed).toBe(1);
    expect(events).toContainEqual({
      type: "error",
      sessionId: "s1",
      message: "Agent input acceptance timed out",
      code: "AGENT_ACCEPTANCE_TIMEOUT",
    });
    expect(events).toContainEqual({
      type: "sessionStatusCheckResult",
      result: {
        requestId: "hung-input-request",
        sessionId: "s1",
        active: false,
        inputReceipt: {
          deliveryId: "hung-input-delivery",
          ownership: "not_owned",
        },
      },
    });
    expect(events).toContainEqual({
      type: "sessionStatusCheckResult",
      result: {
        requestId: "after-hung-input",
        sessionId: "s1",
        active: false,
      },
    });
    expect(events).toContainEqual({
      type: "sessionStatusCheckResult",
      result: {
        requestId: "hung-input-retry",
        sessionId: "s1",
        active: false,
        inputReceipt: {
          deliveryId: "hung-input-delivery",
          ownership: "not_owned",
        },
      },
    });
  });

  it("deduplicates a stable input delivery after its first RPC response is lost", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-stable-input-"),
    );
    const events: RunnerEvent[] = [];
    const delivered: string[] = [];
    let acceptDelivery!: () => void;
    const deliveryAccepted = new Promise<void>((resolve) => {
      acceptDelivery = resolve;
    });
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [deferredInputCodexAgent(delivered, deliveryAccepted)],
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.start(makeSession(workspace), "wait");
    const command = {
      type: "checkSessionStatus" as const,
      requestId: "stable-input-first",
      sessionId: "s1",
      deliverInput: {
        deliveryId: "delivery-stable-1",
        content: "continue once",
      },
    };
    const first = manager.handle(command);
    const retry = manager.handle({
      ...command,
      requestId: "stable-input-retry",
    });
    await vi.waitFor(() => expect(delivered).toEqual(["continue once"]));
    acceptDelivery();
    await Promise.all([first, retry]);

    expect(delivered).toEqual(["continue once"]);
    expect(events).toContainEqual({
      type: "sessionStatusCheckResult",
      result: {
        requestId: "stable-input-retry",
        sessionId: "s1",
        active: true,
        inputReceipt: {
          deliveryId: "delivery-stable-1",
          ownership: "owned",
        },
      },
    });
    manager.control("s1", "stop");
  });

  it("retains stable input ownership across a runner process restart", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-persisted-input-"),
    );
    const stateDir = join(workspace, ".runner-state");
    const delivered: string[] = [];
    const first = new SessionManager({
      workspace,
      stateDir,
      profile: "standard",
      agents: [deferredInputCodexAgent(delivered, Promise.resolve())],
      emit: () => undefined,
    });
    await first.start(makeSession(workspace), "wait");
    await first.handle({
      type: "checkSessionStatus",
      requestId: "persisted-input-first",
      sessionId: "s1",
      deliverInput: {
        deliveryId: "delivery-persisted-1",
        content: "continue once",
      },
    });
    first.control("s1", "stop");

    const events: RunnerEvent[] = [];
    const restarted = new SessionManager({
      workspace,
      stateDir,
      profile: "standard",
      agents: [deferredInputCodexAgent(delivered, Promise.resolve())],
      emit: (event) => {
        events.push(event);
      },
    });
    await restarted.start(makeSession(workspace), "wait again");
    await restarted.handle({
      type: "checkSessionStatus",
      requestId: "persisted-input-retry",
      sessionId: "s1",
      deliverInput: {
        deliveryId: "delivery-persisted-1",
        content: "continue once",
      },
    });
    await restarted.handle({
      type: "checkSessionStatus",
      requestId: "persisted-input-mismatch",
      sessionId: "s1",
      deliverInput: {
        deliveryId: "delivery-persisted-1",
        content: "different payload",
      },
    });

    expect(delivered).toEqual(["continue once"]);
    expect(events).toContainEqual({
      type: "sessionStatusCheckResult",
      result: {
        requestId: "persisted-input-retry",
        sessionId: "s1",
        active: true,
        inputReceipt: {
          deliveryId: "delivery-persisted-1",
          ownership: "owned",
        },
      },
    });
    expect(events).toContainEqual({
      type: "sessionStatusCheckResult",
      result: {
        requestId: "persisted-input-mismatch",
        sessionId: "s1",
        active: true,
        inputReceipt: {
          deliveryId: "delivery-persisted-1",
          ownership: "not_owned",
        },
      },
    });
    restarted.control("s1", "stop");
  });

  it("acknowledges only the matching pending input request and deduplicates retries", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-stable-request-input-"),
    );
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [userInputCodexAgent()],
      emit: (event) => {
        events.push(event);
      },
    });

    const started = manager.start(makeSession(workspace), "wait");
    await vi.waitFor(() =>
      expect(
        events.find(
          (event) =>
            event.type === "agentActivity" &&
            event.inputRequestId !== undefined,
        ),
      ).toBeDefined(),
    );
    const request = events.find(
      (
        event,
      ): event is Extract<RunnerEvent, { type: "agentActivity" }> & {
        inputRequestId: string;
      } => event.type === "agentActivity" && event.inputRequestId !== undefined,
    )!;
    const base = {
      type: "checkSessionStatus" as const,
      sessionId: "s1",
      deliverInput: {
        deliveryId: "delivery-request-1",
        inputRequestId: request.inputRequestId,
        content: "continue",
      },
    };
    await manager.handle({ ...base, requestId: "request-input-first" });
    await manager.handle({ ...base, requestId: "request-input-retry" });
    await started;

    const receipts = events.filter(
      (event) =>
        event.type === "sessionStatusCheckResult" &&
        event.result.inputReceipt?.deliveryId === "delivery-request-1",
    );
    expect(receipts).toHaveLength(2);
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          result: expect.objectContaining({
            inputReceipt: {
              deliveryId: "delivery-request-1",
              ownership: "owned",
            },
          }),
        }),
      ]),
    );

    await manager.handle({
      ...base,
      requestId: "request-input-wrong",
      deliverInput: {
        ...base.deliverInput,
        deliveryId: "delivery-request-wrong",
        inputRequestId: "not-the-pending-request",
      },
    });
    expect(events.at(-1)).toEqual({
      type: "sessionStatusCheckResult",
      result: {
        requestId: "request-input-wrong",
        sessionId: "s1",
        active: false,
        inputReceipt: {
          deliveryId: "delivery-request-wrong",
          ownership: "not_owned",
        },
      },
    });
  });

  it("reports an active atomic input rejection without claiming delivery", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-atomic-input-error-"),
    );
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [unavailableInputCodexAgent()],
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.start(makeSession(workspace), "wait");
    const checked = manager.handle({
      type: "checkSessionStatus",
      requestId: "check-rejected-input",
      sessionId: "s1",
      deliverInput: { content: "continue" },
    });
    await expect(
      Promise.race([
        checked.then(() => "resolved"),
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("timed-out"), 100);
        }),
      ]),
    ).resolves.toBe("resolved");

    expect(events).toContainEqual({
      type: "sessionStatusCheckResult",
      result: {
        requestId: "check-rejected-input",
        sessionId: "s1",
        active: true,
        inputDelivered: false,
      },
    });
    manager.control("s1", "stop");
  });

  it("keeps accepted input delivered when the generation completes before the RPC result", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-accepted-terminal-input-"),
    );
    const events: RunnerEvent[] = [];
    const delivered: string[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [completingInputCodexAgent(delivered)],
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.start(makeSession(workspace), "wait");
    await manager.handle({
      type: "checkSessionStatus",
      requestId: "check-accepted-terminal-input",
      sessionId: "s1",
      deliverInput: { content: "continue once" },
    });

    expect(delivered).toEqual(["continue once"]);
    const terminalIndex = events.findIndex(
      (event) => event.type === "sessionStatus" && event.status === "completed",
    );
    const resultIndex = events.findIndex(
      (event) =>
        event.type === "sessionStatusCheckResult" &&
        event.result.requestId === "check-accepted-terminal-input",
    );
    expect(terminalIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(terminalIndex);
    expect(events[resultIndex]).toEqual({
      type: "sessionStatusCheckResult",
      result: {
        requestId: "check-accepted-terminal-input",
        sessionId: "s1",
        active: false,
        inputDelivered: true,
      },
    });
  });

  it("publishes terminal status before reporting undelivered atomic input", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-terminal-input-barrier-"),
    );
    const controlledAgent = controlledCompletionCodexAgent();
    const events: RunnerEvent[] = [];
    let releaseTerminal!: () => void;
    const terminalReleased = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [controlledAgent.agent],
      emit: async (event) => {
        events.push(event);
        if (event.type === "sessionStatus" && event.status === "completed") {
          await terminalReleased;
        }
      },
    });

    await manager.start(makeSession(workspace), "wait");
    const completing = controlledAgent.complete();
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "sessionStatus",
        sessionId: "s1",
        status: "completed",
      });
    });
    const checked = manager.handle({
      type: "checkSessionStatus",
      requestId: "check-terminal-input",
      sessionId: "s1",
      deliverInput: { content: "continue" },
    });
    await Promise.resolve();
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "sessionStatusCheckResult",
        result: expect.objectContaining({ requestId: "check-terminal-input" }),
      }),
    );

    releaseTerminal();
    await Promise.all([completing, checked]);
    const terminalIndex = events.findIndex(
      (event) => event.type === "sessionStatus" && event.status === "completed",
    );
    const resultIndex = events.findIndex(
      (event) =>
        event.type === "sessionStatusCheckResult" &&
        event.result.requestId === "check-terminal-input",
    );
    expect(terminalIndex).toBeGreaterThanOrEqual(0);
    expect(resultIndex).toBeGreaterThan(terminalIndex);
    expect(events[resultIndex]).toEqual({
      type: "sessionStatusCheckResult",
      result: {
        requestId: "check-terminal-input",
        sessionId: "s1",
        active: false,
        inputDelivered: false,
      },
    });
  });

  it("reports sessions being started as active", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-starting-status-"),
    );
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [longRunningCodexAgent()],
      emit: (event) => {
        events.push(event);
      },
    });

    const started = manager.start(makeSession(workspace), "wait");
    await manager.handle({
      type: "checkSessionStatus",
      requestId: "check-starting",
      sessionId: "s1",
    });

    expect(events).toContainEqual({
      type: "sessionStatusCheckResult",
      result: {
        requestId: "check-starting",
        sessionId: "s1",
        active: true,
      },
    });

    await started;
    manager.control("s1", "stop");
  });

  it("lists agent runtime config options from the selected agent definition", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-runtime-options-"),
    );
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [runtimeConfigCodexAgent()],
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.handle({
      type: "listAgentRuntimeConfigOptions",
      requestId: "runtime-options-1",
      agent: "codex",
      basePath: workspace,
    });

    expect(events).toContainEqual({
      type: "agentRuntimeConfigOptionsResult",
      result: {
        requestId: "runtime-options-1",
        agent: "codex",
        basePath: workspace,
        queriedAt: "2026-07-03T00:00:00.000Z",
        models: [
          {
            value: "gpt-5.4-codex",
            label: "GPT-5.4 Codex",
            reasoningEfforts: [{ value: "high", label: "High" }],
            serviceTiers: [{ value: "flex", label: "Flex" }],
            supportsFastMode: true,
          },
        ],
        allowCustomModel: false,
        reasoningEfforts: [{ value: "high", label: "High" }],
        fastMode: {
          kind: "serviceTier",
          supported: true,
          options: [{ value: "flex", label: "Flex" }],
        },
      },
    });
  });

  it("returns unsupported runtime config options for agents without dynamic metadata", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-runtime-options-empty-"),
    );
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [longRunningCodexAgent()],
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.handle({
      type: "listAgentRuntimeConfigOptions",
      requestId: "runtime-options-empty",
      agent: "codex",
      basePath: workspace,
    });

    expect(events).toContainEqual({
      type: "agentRuntimeConfigOptionsResult",
      result: expect.objectContaining({
        requestId: "runtime-options-empty",
        agent: "codex",
        basePath: workspace,
        models: [],
        allowCustomModel: false,
        reasoningEfforts: [],
        fastMode: { kind: "unsupported", supported: false },
      }),
    });
  });

  it("handles patch commands with structured results", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-patch-"),
    );
    await writeFile(join(workspace, "README.md"), "old\n");
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: await fakeCodexAgents(workspace),
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.start(makeSession(workspace), "ready");
    const patch = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    await manager.handle(patchCommand(patch));

    expect(events).toContainEqual({
      type: "patchApplyResult",
      result: {
        requestId: "patch1",
        sessionId: "s1",
        applied: true,
        changedFiles: ["README.md"],
        message: "applied",
        rejected: [],
      },
    });
    await expect(readFile(join(workspace, "README.md"), "utf8")).resolves.toBe(
      "new\n",
    );
  });

  it("resolves pending user input through ordinary session input", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "roam-runner-session-user-input-"),
    );
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [userInputCodexAgent()],
      emit: (event) => {
        events.push(event);
      },
    });

    const started = manager.start(makeSession(workspace), "ready");
    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "sessionStatus",
        sessionId: "s1",
        status: "waiting_input",
      });
    });

    await manager.handle({
      type: "resolveUserInput",
      sessionId: "s1",
      content: "continue",
    });
    await manager.handle({
      type: "resolveUserInput",
      sessionId: "s1",
      content: "duplicate",
    });

    await vi.waitFor(() => {
      expect(events).toContainEqual({
        type: "agentActivity",
        sessionId: "s1",
        agent: "codex",
        kind: "tool",
        label: "answered: continue",
      });
      expect(events).toContainEqual({
        type: "sessionStatus",
        sessionId: "s1",
        status: "completed",
      });
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "error",
        code: "SESSION_NOT_WAITING_INPUT",
      }),
    );
    expect(events).not.toContainEqual({
      type: "sessionStatus",
      sessionId: "s1",
      status: "failed",
    });
    await started;
  });
});

async function fakeCodexAgents(workspace: string): Promise<LoadedAgent[]> {
  const script = join(workspace, "fake-codex.mjs");
  await writeFile(
    script,
    [
      "const prompt = process.argv.at(-1) ?? '';",
      "const resumed = process.argv.includes('resume');",
      "console.log(JSON.stringify({ type: 'thread.started', thread_id: resumed ? 'codex-thread-resumed' : 'codex-thread-1' }));",
      "console.log(JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: `codex answer: ${prompt}` } }));",
    ].join("\n"),
  );
  vi.stubEnv("ROAMCLI_AGENT_CODEX_MODE", "exec-json");
  vi.stubEnv("ROAMCLI_AGENT_CODEX_COMMAND", process.execPath);
  vi.stubEnv("ROAMCLI_AGENT_CODEX_ARGS", JSON.stringify([script]));
  return (await loadAgentRegistry("trusted", ["@roamcli/agent-codex"])).agents;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function artifactCodexAgent(): LoadedAgent {
  let emitted = false;
  const capability = {
    kind: "codex",
    label: "Codex",
    command: process.execPath,
    args: [],
    parser: "test-artifact",
    supportsResume: true,
    supportsImages: false,
    supportedImageMimeTypes: [],
    maxImagesPerTurn: 0,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
    pluginName: "test-codex",
    pluginVersion: "1.0.0",
  } satisfies LoadedAgent["capability"];
  return {
    capability,
    definition: {
      kind: "codex",
      label: "Codex",
      buildCapability() {
        return capability;
      },
      createSession(context) {
        return new TestAgentSession(context, async () => {
          if (!emitted) {
            emitted = true;
            await context.emit({
              type: "artifact",
              draft: {
                path: "result.log",
                kind: "log",
                mimeType: "text/plain",
              },
            });
          }
          await context.emit({ type: "status", status: "completed" });
        });
      },
    },
  };
}

function approvalCodexAgent(): LoadedAgent {
  let emitted = false;
  const capability = {
    kind: "codex",
    label: "Codex",
    command: process.execPath,
    args: [],
    parser: "test-approval",
    supportsResume: true,
    supportsImages: false,
    supportedImageMimeTypes: [],
    maxImagesPerTurn: 0,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
    pluginName: "test-codex",
    pluginVersion: "1.0.0",
  } satisfies LoadedAgent["capability"];
  return {
    capability,
    definition: {
      kind: "codex",
      label: "Codex",
      buildCapability() {
        return capability;
      },
      createSession(context) {
        return new TestAgentSession(context, async () => {
          if (!emitted) {
            emitted = true;
            void context.requestApproval({
              kind: "execCommand",
              summary: "Approve stale command",
              payload: { command: "echo ok" },
            });
          }
          await context.emit({ type: "status", status: "completed" });
        });
      },
    },
  };
}

function userInputCodexAgent(): LoadedAgent {
  const capability = {
    kind: "codex",
    label: "Codex",
    command: process.execPath,
    args: [],
    parser: "test-user-input",
    supportsResume: true,
    supportsImages: false,
    supportedImageMimeTypes: [],
    maxImagesPerTurn: 0,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
    pluginName: "test-codex",
    pluginVersion: "1.0.0",
  } satisfies LoadedAgent["capability"];
  return {
    capability,
    definition: {
      kind: "codex",
      label: "Codex",
      buildCapability() {
        return capability;
      },
      createSession(context) {
        return new TestAgentSession(context, async () => {
          const decision = await context.requestUserInput?.({
            summary: "Need direction",
            questions: [
              {
                id: "next",
                header: "Next",
                question: "What next?",
                isOther: false,
                isSecret: false,
                options: null,
              },
            ],
            payload: { source: "test" },
          });
          await context.emit({
            type: "activity",
            kind: "tool",
            label: `answered: ${decision?.content ?? ""}`,
          });
          await context.emit({ type: "status", status: "completed" });
        });
      },
    },
  };
}

function throwingParserCodexAgent(): LoadedAgent {
  const capability = {
    kind: "codex",
    label: "Codex",
    command: process.execPath,
    args: [],
    parser: "test-throwing-parser",
    supportsResume: true,
    supportsImages: false,
    supportedImageMimeTypes: [],
    maxImagesPerTurn: 0,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
    pluginName: "test-codex",
    pluginVersion: "1.0.0",
  } satisfies LoadedAgent["capability"];
  return {
    capability,
    definition: {
      kind: "codex",
      label: "Codex",
      buildCapability() {
        return capability;
      },
      createSession(context) {
        return new TestAgentSession(context, async () => {
          await context.emit({ type: "status", status: "completed" });
        });
      },
    },
  };
}

function throwingInputCodexAgent(): LoadedAgent {
  const capability = {
    kind: "codex",
    label: "Codex",
    command: process.execPath,
    args: [],
    parser: "test-throwing-input",
    supportsResume: true,
    supportsImages: false,
    supportedImageMimeTypes: [],
    maxImagesPerTurn: 0,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
    pluginName: "test-codex",
    pluginVersion: "1.0.0",
  } satisfies LoadedAgent["capability"];
  return {
    capability,
    definition: {
      kind: "codex",
      label: "Codex",
      buildCapability() {
        return capability;
      },
      createSession(context) {
        return new TestAgentSession(context, undefined, () => {
          throw new Error("input boom");
        });
      },
    },
  };
}

function unavailableInputCodexAgent(): LoadedAgent {
  const agent = longRunningCodexAgent();
  return {
    ...agent,
    definition: {
      ...agent.definition,
      createSession(context) {
        return new TestAgentSession(context, undefined, () => {
          throw new AgentInputUnavailableError();
        });
      },
    },
  };
}

function throwingControlCodexAgent(): {
  agent: LoadedAgent;
  closed: () => boolean;
} {
  let closed = false;
  const capability = {
    kind: "codex",
    label: "Codex",
    command: process.execPath,
    args: [],
    parser: "test-throwing-control",
    supportsResume: true,
    supportsImages: false,
    supportedImageMimeTypes: [],
    maxImagesPerTurn: 0,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
    pluginName: "test-codex",
    pluginVersion: "1.0.0",
  } satisfies LoadedAgent["capability"];
  return {
    agent: {
      capability,
      definition: {
        kind: "codex",
        label: "Codex",
        buildCapability() {
          return capability;
        },
        createSession(context) {
          return new TestAgentSession(
            context,
            undefined,
            undefined,
            () => {
              throw new Error("control boom");
            },
            () => {
              closed = true;
            },
          );
        },
      },
    },
    closed: () => closed,
  };
}

function controlledCompletionCodexAgent(): {
  agent: LoadedAgent;
  complete: () => Promise<void>;
  emitLateRunning: () => Promise<void>;
  requestLateApproval: () => Promise<unknown>;
  requestLateInput: () => Promise<unknown>;
} {
  let capturedContext: AgentSessionContext | undefined;
  const capability = {
    kind: "codex",
    label: "Codex",
    command: process.execPath,
    args: [],
    parser: "test-controlled-completion",
    supportsResume: true,
    supportsImages: false,
    supportedImageMimeTypes: [],
    maxImagesPerTurn: 0,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
    pluginName: "test-codex",
    pluginVersion: "1.0.0",
  } satisfies LoadedAgent["capability"];
  return {
    agent: {
      capability,
      definition: {
        kind: "codex",
        label: "Codex",
        buildCapability() {
          return capability;
        },
        createSession(context) {
          capturedContext = context;
          return new TestAgentSession(context);
        },
      },
    },
    async complete() {
      if (capturedContext === undefined) {
        throw new Error("controlled session was not started");
      }
      await capturedContext.emit({ type: "status", status: "completed" });
    },
    async emitLateRunning() {
      if (capturedContext === undefined) {
        throw new Error("controlled session was not started");
      }
      await capturedContext.emit({ type: "status", status: "running" });
    },
    async requestLateApproval() {
      if (capturedContext === undefined) {
        throw new Error("controlled session was not started");
      }
      return capturedContext.requestApproval({
        kind: "execCommand",
        summary: "Late approval",
        payload: {},
      });
    },
    async requestLateInput() {
      if (capturedContext?.requestUserInput === undefined) {
        throw new Error("controlled session was not started");
      }
      return capturedContext.requestUserInput({
        summary: "Late input",
        questions: [plainInputQuestion()],
        payload: {},
      });
    },
  };
}

function failThenRequestInputCodexAgent(): {
  agent: LoadedAgent;
  closedCount: () => number;
} {
  let created = 0;
  let closed = 0;
  const capability = {
    kind: "codex",
    label: "Codex",
    command: process.execPath,
    args: [],
    parser: "test-start-cleanup",
    supportsResume: true,
    supportsImages: false,
    supportedImageMimeTypes: [],
    maxImagesPerTurn: 0,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
    pluginName: "test-codex",
    pluginVersion: "1.0.0",
  } satisfies LoadedAgent["capability"];
  return {
    agent: {
      capability,
      definition: {
        kind: "codex",
        label: "Codex",
        buildCapability() {
          return capability;
        },
        createSession(context) {
          created += 1;
          if (created === 1) {
            return new TestAgentSession(
              context,
              async () => {
                void context
                  .requestUserInput?.({
                    summary: "First pending input",
                    questions: [plainInputQuestion()],
                    payload: {},
                  })
                  .catch(() => undefined);
                await new Promise((resolve) => setTimeout(resolve, 0));
                throw new Error("start boom");
              },
              undefined,
              undefined,
              () => {
                closed += 1;
              },
            );
          }
          return new TestAgentSession(context, async () => {
            await context.requestUserInput?.({
              summary: "Second input",
              questions: [plainInputQuestion()],
              payload: {},
            });
            await context.emit({ type: "status", status: "completed" });
          });
        },
      },
    },
    closedCount: () => closed,
  };
}

function closeTrackingCodexAgent(): {
  agent: LoadedAgent;
  closedCount: () => number;
} {
  let closed = 0;
  const capability = {
    kind: "codex",
    label: "Codex",
    command: process.execPath,
    args: [],
    parser: "test-close-tracking",
    supportsResume: true,
    supportsImages: false,
    supportedImageMimeTypes: [],
    maxImagesPerTurn: 0,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
    pluginName: "test-codex",
    pluginVersion: "1.0.0",
  } satisfies LoadedAgent["capability"];
  return {
    agent: {
      capability,
      definition: {
        kind: "codex",
        label: "Codex",
        buildCapability() {
          return capability;
        },
        createSession(context) {
          return new TestAgentSession(
            context,
            undefined,
            undefined,
            undefined,
            () => {
              closed += 1;
            },
          );
        },
      },
    },
    closedCount: () => closed,
  };
}

function plainInputQuestion() {
  return {
    id: "next",
    header: "Next",
    question: "What next?",
    isOther: false,
    isSecret: false,
    options: null,
  } as const;
}

function longRunningCodexAgent(): LoadedAgent {
  const capability = {
    kind: "codex",
    label: "Codex",
    command: process.execPath,
    args: [],
    parser: "test-long-running",
    supportsResume: true,
    supportsImages: false,
    supportedImageMimeTypes: [],
    maxImagesPerTurn: 0,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
    pluginName: "test-codex",
    pluginVersion: "1.0.0",
  } satisfies LoadedAgent["capability"];
  return {
    capability,
    definition: {
      kind: "codex",
      label: "Codex",
      buildCapability() {
        return capability;
      },
      createSession(context) {
        return new TestAgentSession(context);
      },
    },
  };
}

function startCountingCodexAgent(): {
  agent: LoadedAgent;
  created: () => number;
} {
  const base = longRunningCodexAgent();
  let created = 0;
  return {
    agent: {
      ...base,
      definition: {
        ...base.definition,
        createSession(context) {
          created += 1;
          return new TestAgentSession(context);
        },
      },
    },
    created: () => created,
  };
}

function deferredInputCodexAgent(
  delivered: string[],
  deliveryAccepted: Promise<void>,
): LoadedAgent {
  const agent = longRunningCodexAgent();
  return {
    ...agent,
    definition: {
      ...agent.definition,
      createSession(context) {
        return new TestAgentSession(context, undefined, async (input) => {
          delivered.push(input.content);
          await deliveryAccepted;
        });
      },
    },
  };
}

function completingInputCodexAgent(delivered: string[]): LoadedAgent {
  const agent = longRunningCodexAgent();
  return {
    ...agent,
    definition: {
      ...agent.definition,
      createSession(context) {
        return new TestAgentSession(context, undefined, async (input) => {
          delivered.push(input.content);
          await context.emit({ type: "status", status: "completed" });
        });
      },
    },
  };
}

function runtimeConfigCodexAgent(): LoadedAgent {
  const capability = {
    kind: "codex",
    label: "Codex",
    command: process.execPath,
    args: [],
    parser: "test-runtime-config",
    supportsResume: true,
    supportsImages: false,
    supportedImageMimeTypes: [],
    maxImagesPerTurn: 0,
    maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
    pluginName: "test-codex",
    pluginVersion: "1.0.0",
  } satisfies LoadedAgent["capability"];
  return {
    capability,
    definition: {
      kind: "codex",
      label: "Codex",
      buildCapability() {
        return capability;
      },
      createSession(context) {
        return new TestAgentSession(context);
      },
      async listRuntimeConfigOptions() {
        return {
          queriedAt: "2026-07-03T00:00:00.000Z",
          models: [
            {
              value: "gpt-5.4-codex",
              label: "GPT-5.4 Codex",
              reasoningEfforts: [{ value: "high", label: "High" }],
              serviceTiers: [{ value: "flex", label: "Flex" }],
              supportsFastMode: true,
            },
          ],
          allowCustomModel: false,
          reasoningEfforts: [{ value: "high", label: "High" }],
          fastMode: {
            kind: "serviceTier" as const,
            supported: true as const,
            options: [{ value: "flex", label: "Flex" }],
          },
        };
      },
    },
  };
}

class TestAgentSession implements AgentSession {
  readonly #context: AgentSessionContext;
  readonly #start: (() => Promise<void> | void) | undefined;
  readonly #deliverInput:
    | ((input: AgentInput) => Promise<void> | void)
    | undefined;
  readonly #control:
    | ((signal: "interrupt" | "stop" | "resume") => Promise<void> | void)
    | undefined;
  readonly #close: (() => Promise<void> | void) | undefined;

  public constructor(
    context: AgentSessionContext,
    start?: () => Promise<void> | void,
    deliverInput?: (input: AgentInput) => Promise<void> | void,
    control?: (signal: "interrupt" | "stop" | "resume") => Promise<void> | void,
    close?: () => Promise<void> | void,
  ) {
    this.#context = context;
    this.#start = start;
    this.#deliverInput = deliverInput;
    this.#control = control;
    this.#close = close;
  }

  public async start(): Promise<void> {
    await this.#start?.();
  }

  public deliverInput(input: AgentInput): Promise<void> | void {
    return this.#deliverInput?.(input);
  }

  public control(
    signal: "interrupt" | "stop" | "resume",
  ): Promise<void> | void {
    if (this.#control !== undefined) {
      return this.#control(signal);
    }
    if (signal === "stop") {
      return this.#context.emit({ type: "status", status: "stopped" });
    }
  }

  public close(): Promise<void> | void {
    return this.#close?.();
  }
}

function makeSession(workspace: string): Session {
  return {
    id: "s1",
    title: "Session",
    projectId: "project-1",
    runnerId: "r1",
    agent: "codex",
    status: "pending",
    executionMode: "direct",
    executionFolder: workspace,
    cwd: workspace,
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
  };
}

function patchCommand(patch: string) {
  return {
    type: "applyPatch" as const,
    requestId: "patch1",
    sessionId: "s1",
    patch,
  };
}
