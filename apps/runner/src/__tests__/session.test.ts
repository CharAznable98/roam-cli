import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerEvent, Session } from "@roamcli/protocol";
import { hashPayload, signApproval } from "@roamcli/security";
import { describe, expect, it, vi } from "vitest";
import { buildCapabilities } from "../capabilities.js";
import { SessionManager } from "../session.js";

const approvalSecret = "runner-test-secret";

describe("SessionManager", () => {
  it("runs the mock agent through the process adapter and accepts interactive input", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-session-"));
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      capabilities: buildCapabilities("standard").filter((capability) => capability.kind === "mock"),
      approvalSecret,
      emit: (event) => {
        events.push(event);
      }
    });

    await manager.start(makeSession(workspace), "hello");
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "token" && event.content.includes("hello"))).toBe(true);
    });

    manager.deliverInput("s1", "again");
    await vi.waitFor(() => {
      expect(events.some((event) => event.type === "token" && event.content.includes("again"))).toBe(true);
    });

    manager.control("s1", "stop");
    await vi.waitFor(() => {
      expect(events).toContainEqual({ type: "sessionStatus", sessionId: "s1", status: "stopped" });
    });
  });

  it("handles file tree and content commands scoped to a started session cwd", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-session-files-"));
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "main.ts"), "console.log('ok');");
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      capabilities: buildCapabilities("standard").filter((capability) => capability.kind === "mock"),
      emit: (event) => {
        events.push(event);
      }
    });

    await manager.start(makeSession(workspace), "ready");
    await manager.handle({ type: "readFileTree", requestId: "tree1", sessionId: "s1", path: ".", depth: 1 });
    await manager.handle({ type: "readFileContent", requestId: "content1", sessionId: "s1", path: "src/main.ts", maxBytes: 7 });
    await manager.handle({
      type: "writeFileContent",
      requestId: "write1",
      sessionId: "s1",
      path: "src/main.ts",
      content: "console.log('saved');"
    });
    manager.control("s1", "stop");

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "fileTreeResult",
        result: expect.objectContaining({ requestId: "tree1", sessionId: "s1" })
      })
    );
    expect(events).toContainEqual({
      type: "fileContentResult",
      result: {
        requestId: "content1",
        sessionId: "s1",
        path: "src/main.ts",
        content: "console",
        truncated: true,
        encoding: "utf8"
      }
    });
    expect(events).toContainEqual({
      type: "fileWriteResult",
      result: {
        requestId: "write1",
        sessionId: "s1",
        path: "src/main.ts",
        bytesWritten: 21,
        encoding: "utf8"
      }
    });
    await expect(readFile(join(workspace, "src", "main.ts"), "utf8")).resolves.toBe("console.log('saved');");
  });

  it("handles patch commands with structured results", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-session-patch-"));
    await writeFile(join(workspace, "README.md"), "old\n");
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      capabilities: buildCapabilities("standard").filter((capability) => capability.kind === "mock"),
      emit: (event) => {
        events.push(event);
      }
    });

    await manager.start(makeSession(workspace), "ready");
    const patch = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      ""
    ].join("\n");
    await manager.handle(signedPatchCommand(patch));
    manager.control("s1", "stop");

    expect(events).toContainEqual({
      type: "patchApplyResult",
      result: {
        requestId: "patch1",
        sessionId: "s1",
        applied: true,
        changedFiles: ["README.md"],
        message: "applied",
        rejected: []
      }
    });
    await expect(readFile(join(workspace, "README.md"), "utf8")).resolves.toBe("new\n");
  });

  it("rejects patch commands whose forwarded signature does not match the patch body", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-session-patch-signature-"));
    await writeFile(join(workspace, "README.md"), "old\n");
    const events: RunnerEvent[] = [];
    const manager = new SessionManager({
      workspace,
      capabilities: buildCapabilities("standard").filter((capability) => capability.kind === "mock"),
      approvalSecret,
      emit: (event) => {
        events.push(event);
      }
    });

    const patch = [
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      ""
    ].join("\n");
    await manager.start(makeSession(workspace), "ready");
    await manager.handle(signedPatchCommand(patch, `${patch}\n# tampered-target`));
    manager.control("s1", "stop");

    expect(events).toContainEqual({
      type: "patchApplyResult",
      result: {
        requestId: "patch1",
        sessionId: "s1",
        applied: false,
        changedFiles: [],
        message: "Patch signature is invalid",
        rejected: ["Patch signature is invalid"]
      }
    });
    await expect(readFile(join(workspace, "README.md"), "utf8")).resolves.toBe("old\n");
  });
});

function makeSession(workspace: string): Session {
  return {
    id: "s1",
    title: "Session",
    runnerId: "r1",
    agent: "mock",
    status: "pending",
    cwd: workspace,
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z"
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
    signature: signApproval(approvalSecret, `patch:s1:${hashPayload(signedPatch)}`, true, signedAt)
  };
}
