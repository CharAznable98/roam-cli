import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentOutputParser, AgentParseResult } from "@roamcli/agent-plugin-sdk";
import type { RunnerEvent, Session } from "@roamcli/protocol";
import { hashPayload, signApproval } from "@roamcli/security";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAgentRegistry, type LoadedAgent } from "../agents/registry.js";
import { SessionManager } from "../sessions/manager.js";

const approvalSecret = "runner-test-secret";
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
      approvalSecret,
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.start(makeSession(workspace), "hello");

    await vi.waitFor(() => {
      expect(events).toContainEqual({ type: "sessionThread", sessionId: "s1", threadId: "codex-thread-1" });
      expect(events.some((event) => event.type === "assistantMessage" && event.content.includes("codex answer: hello"))).toBe(true);
      expect(events).toContainEqual({ type: "sessionStatus", sessionId: "s1", status: "completed" });
    });
  });

  it("handles file tree and content commands scoped to a started codex session cwd", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-session-files-"));
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
    await manager.handle({ type: "readFileTree", requestId: "tree1", sessionId: "s1", path: ".", depth: 1 });
    await manager.handle({ type: "readFileContent", requestId: "content1", sessionId: "s1", path: "src/main.ts", maxBytes: 7 });
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
        result: expect.objectContaining({ requestId: "tree1", sessionId: "s1" }),
      }),
    );
    expect(events).toContainEqual({
      type: "fileContentResult",
      result: {
        requestId: "content1",
        sessionId: "s1",
        path: "src/main.ts",
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
    await expect(readFile(join(workspace, "src", "main.ts"), "utf8")).resolves.toBe("console.log('saved');");
  });

  it("creates managed git worktrees and scopes the session to the execution folder", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-session-worktree-"));
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
    };

    await manager.start(managedSession, "managed");
    await vi.waitFor(() => {
      expect(events).toContainEqual({ type: "sessionStatus", sessionId: "s1", status: "completed" });
    });
    await manager.handle({ type: "readFileContent", requestId: "content1", sessionId: "s1", path: "README.md", maxBytes: 256 });

    await expect(readFile(join(executionFolder, "README.md"), "utf8")).resolves.toBe("hello\n");
    expect(events).toContainEqual({
      type: "fileContentResult",
      result: {
        requestId: "content1",
        sessionId: "s1",
        path: "README.md",
        content: "hello\n",
        truncated: false,
        encoding: "utf8",
      },
    });

    events.length = 0;
    await manager.start(managedSession, "resume managed", "codex-thread-1");
    await vi.waitFor(() => {
      expect(events).toContainEqual({ type: "sessionThread", sessionId: "s1", threadId: "codex-thread-resumed" });
      expect(events).toContainEqual({ type: "sessionStatus", sessionId: "s1", status: "completed" });
    });
    expect(events.some((event) => event.type === "error" && event.code === "SPAWN_ERROR")).toBe(false);
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
        content: "console",
        truncated: true,
        encoding: "utf8",
      },
    });
  });

  it("returns request-scoped errors for file commands without cwd context", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-session-missing-cwd-"));
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

  it("resolves plugin-emitted artifact paths inside the started codex session cwd", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-session-artifact-"));
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
    expect(events.some((event) => event.type === "error" && event.code === "ARTIFACT_ERROR")).toBe(false);
  });

  it("does not mark an exited one-shot codex process running when a stale approval is resolved", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-session-stale-approval-"));
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
      expect(events.some((event) => event.type === "approvalRequested")).toBe(true);
      expect(events).toContainEqual({ type: "sessionStatus", sessionId: "s1", status: "completed" });
    });
    const approval = events.find((event) => event.type === "approvalRequested");
    if (approval?.type !== "approvalRequested") {
      throw new Error("approval was not emitted");
    }

    manager.resolveApproval(approval.approval.id, true, "2026-06-05T00:00:00.000Z", "signature");

    const statusEvents = events.filter((event) => event.type === "sessionStatus");
    expect(statusEvents.at(-1)).toEqual({ type: "sessionStatus", sessionId: "s1", status: "completed" });
    expect(statusEvents.slice(2)).not.toContainEqual({
      type: "sessionStatus",
      sessionId: "s1",
      status: "running",
    });
  });

  it("emits one-shot process exit status after delayed approval output handling", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-session-approval-order-"));
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [approvalCodexAgent()],
      emit: async (event) => {
        if (event.type === "sessionStatus" && event.status === "waiting_approval") {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        events.push(event);
      },
    });

    await manager.start(makeSession(workspace), "approval please");

    await vi.waitFor(() => {
      const statusEvents = events.filter((event) => event.type === "sessionStatus");
      expect(statusEvents.at(-1)).toEqual({
        type: "sessionStatus",
        sessionId: "s1",
        status: "completed",
      });
    });
  });

  it("finalizes the session when output handling rejects", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-session-output-error-"));
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: [throwingParserCodexAgent()],
      emit: (event) => {
        events.push(event);
      },
    });

    await manager.start(makeSession(workspace), "ready");

    await vi.waitFor(() => {
      expect(events).toContainEqual({ type: "sessionStatus", sessionId: "s1", status: "completed" });
    });
    manager.deliverInput("s1", "late input");

    expect(events).toContainEqual({
      type: "error",
      sessionId: "s1",
      message: "Session is not running",
      code: "SESSION_NOT_RUNNING",
    });
  });

  it("handles patch commands with structured results", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-session-patch-"));
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
    await manager.handle(signedPatchCommand(patch));

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
    await expect(readFile(join(workspace, "README.md"), "utf8")).resolves.toBe("new\n");
  });

  it("rejects patch commands whose forwarded signature does not match the patch body", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-session-patch-signature-"));
    await writeFile(join(workspace, "README.md"), "old\n");
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      profile: "standard",
      agents: await fakeCodexAgents(workspace),
      approvalSecret,
      emit: (event) => {
        events.push(event);
      },
    });

    const patch = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    await manager.start(makeSession(workspace), "ready");
    await manager.handle(signedPatchCommand(patch, `${patch}\n# tampered-target`));

    expect(events).toContainEqual({
      type: "patchApplyResult",
      result: {
        requestId: "patch1",
        sessionId: "s1",
        applied: false,
        changedFiles: [],
        message: "Patch signature is invalid",
        rejected: ["Patch signature is invalid"],
      },
    });
    await expect(readFile(join(workspace, "README.md"), "utf8")).resolves.toBe("old\n");
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
  vi.stubEnv("ROAMCLI_AGENT_CODEX_COMMAND", process.execPath);
  vi.stubEnv("ROAMCLI_AGENT_CODEX_ARGS", JSON.stringify([script]));
  return (await loadAgentRegistry("standard")).agents;
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
      buildLaunch() {
        return {
          command: process.execPath,
          args: ["-e", "process.stdout.write('artifact-ready\\n')"],
          preferPty: false,
          requirePty: false,
          promptDelivery: "argument",
        };
      },
      createParser(): AgentOutputParser {
        return {
          feed(): AgentParseResult {
            if (emitted) {
              return { text: "", approvals: [], artifacts: [] };
            }
            emitted = true;
            return {
              text: "",
              approvals: [],
              artifacts: [{ path: "result.log", kind: "log", mimeType: "text/plain" }],
            };
          },
        };
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
      buildLaunch() {
        return {
          command: process.execPath,
          args: ["-e", "process.stdout.write('approval-ready\\n')"],
          preferPty: false,
          requirePty: false,
          promptDelivery: "argument",
        };
      },
      createParser(): AgentOutputParser {
        return {
          feed(): AgentParseResult {
            if (emitted) {
              return { text: "", approvals: [], artifacts: [] };
            }
            emitted = true;
            return {
              text: "",
              approvals: [{ kind: "execCommand", summary: "Approve stale command", payload: { command: "echo ok" } }],
              artifacts: [],
            };
          },
        };
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
      buildLaunch() {
        return {
          command: process.execPath,
          args: ["-e", "process.stdout.write('malformed output\\n')"],
          preferPty: false,
          requirePty: false,
          promptDelivery: "argument",
        };
      },
      createParser(): AgentOutputParser {
        return {
          feed(): AgentParseResult {
            throw new Error("parser failed");
          },
        };
      },
    },
  };
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

function signedPatchCommand(patch: string, signedPatch = patch) {
  const signedAt = "2026-06-05T00:00:00.000Z";
  return {
    type: "applyPatch" as const,
    requestId: "patch1",
    sessionId: "s1",
    patch,
    signedAt,
    signature: signApproval(approvalSecret, `patch:s1:${hashPayload(signedPatch)}`, true, signedAt),
  };
}
