import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  AgentInput,
  AgentSession,
  AgentSessionContext,
} from "@roamcli/agent-plugin-sdk";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  type RunnerEvent,
  type Session,
} from "@roamcli/shared/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAgentRegistry, type LoadedAgent } from "../agents/registry.js";
import { SessionManager } from "../sessions/manager.js";

const execFileAsync = promisify(execFile);

describe("SessionManager", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
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
      message: `Managed worktree path is not registered for the project: ${executionFolder}`,
      code: "INVALID_CWD",
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
            storagePath: join(sessionCwd, "result.log"),
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

  it("does not mark an exited one-shot codex process running when a stale approval is resolved", async () => {
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
      expect(events.some((event) => event.type === "approvalRequested")).toBe(
        true,
      );
      expect(events).toContainEqual({
        type: "sessionStatus",
        sessionId: "s1",
        status: "completed",
      });
    });
    const approval = events.find((event) => event.type === "approvalRequested");
    if (approval?.type !== "approvalRequested") {
      throw new Error("approval was not emitted");
    }

    manager.resolveApproval(approval.approval.id, true);

    const statusEvents = events.filter(
      (event) => event.type === "sessionStatus",
    );
    expect(statusEvents.at(-1)).toEqual({
      type: "sessionStatus",
      sessionId: "s1",
      status: "completed",
    });
    expect(statusEvents.slice(2)).not.toContainEqual({
      type: "sessionStatus",
      sessionId: "s1",
      status: "running",
    });
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
  return (await loadAgentRegistry("standard", ["@roamcli/agent-codex"])).agents;
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
            async () => {
              closed = true;
              await context.emit({ type: "status", status: "stopped" });
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
  };
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
