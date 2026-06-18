import type {
  ApiApplyPatch,
  ApiWriteFile,
  FileContentResult,
  FileTreeResult,
  FileWriteResult,
  PatchApplyResult,
} from "@roamcli/shared/protocol";
import { RunnerRpcClient } from "../../infra/runner-rpc-client.js";
import type { ServerStore } from "../../infra/sqlite-store.js";
import { newId } from "../../infra/ids.js";
import { fail, ok, type ServiceResult } from "../result.js";
import type { ApprovalSignatureVerifier } from "../approvals/approval-signatures.js";

export interface FileTreeQuery {
  path: string;
  depth: number;
}

export interface FileContentQuery {
  path: string;
  maxBytes: number;
}

export class WorkspaceService {
  constructor(
    private readonly store: ServerStore,
    private readonly rpc: RunnerRpcClient,
    private readonly signatures: ApprovalSignatureVerifier,
    private readonly runnerRpcTimeoutMs: number,
  ) {}

  async readFileTree(
    sessionId: string,
    query: FileTreeQuery,
  ): Promise<ServiceResult<{ result: FileTreeResult }>> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      return fail("session_not_found");
    }
    if (
      session.executionMode === "managed_worktree" &&
      session.worktreeDeletedAt
    ) {
      return fail("worktree_not_available");
    }

    const result = await this.rpc.requestRunner<FileTreeResult>(
      session.runnerId,
      {
        type: "readFileTree",
        requestId: newId("file_tree"),
        sessionId: session.id,
        cwd: session.executionFolder,
        path: query.path,
        depth: query.depth,
      },
      this.runnerRpcTimeoutMs,
    );
    return ok({ result });
  }

  async readFileContent(
    sessionId: string,
    query: FileContentQuery,
  ): Promise<ServiceResult<{ result: FileContentResult }>> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      return fail("session_not_found");
    }
    if (
      session.executionMode === "managed_worktree" &&
      session.worktreeDeletedAt
    ) {
      return fail("worktree_not_available");
    }

    const result = await this.rpc.requestRunner<FileContentResult>(
      session.runnerId,
      {
        type: "readFileContent",
        requestId: newId("file_content"),
        sessionId: session.id,
        cwd: session.executionFolder,
        path: query.path,
        maxBytes: query.maxBytes,
      },
      this.runnerRpcTimeoutMs,
    );
    return ok({ result });
  }

  async writeFileContent(
    sessionId: string,
    body: ApiWriteFile,
  ): Promise<ServiceResult<{ result: FileWriteResult }>> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      return fail("session_not_found");
    }
    if (
      session.executionMode === "managed_worktree" &&
      session.worktreeDeletedAt
    ) {
      return fail("worktree_not_available");
    }

    const result = await this.rpc.requestRunner<FileWriteResult>(
      session.runnerId,
      {
        type: "writeFileContent",
        requestId: newId("file_write"),
        sessionId: session.id,
        cwd: session.executionFolder,
        path: body.path,
        content: body.content,
        encoding: body.encoding,
      },
      this.runnerRpcTimeoutMs,
    );
    return ok({ result });
  }

  async applyPatch(
    sessionId: string,
    body: ApiApplyPatch,
  ): Promise<ServiceResult<{ result: PatchApplyResult }>> {
    const session = this.store.getSession(sessionId);
    if (!session) {
      return fail("session_not_found");
    }
    if (
      session.executionMode === "managed_worktree" &&
      session.worktreeDeletedAt
    ) {
      return fail("worktree_not_available");
    }
    if (
      !this.signatures.isPatchSignatureValid(
        session.id,
        body.patch,
        body.signedAt,
        body.signature,
      )
    ) {
      return fail("invalid_signature");
    }

    const result = await this.rpc.requestRunner<PatchApplyResult>(
      session.runnerId,
      {
        type: "applyPatch",
        requestId: newId("patch_apply"),
        sessionId: session.id,
        patch: body.patch,
        strip: body.strip,
        signedAt: body.signedAt,
        signature: body.signature,
      },
      this.runnerRpcTimeoutMs,
    );
    return ok({ result });
  }

  async validateRunnerDirectory(runnerId: string, directory: string): Promise<void> {
    await this.rpc.requestRunner<FileTreeResult>(
      runnerId,
      {
        type: "readFileTree",
        requestId: newId("project_directory"),
        sessionId: `project-directory-${newId("check")}`,
        cwd: directory,
        path: ".",
        depth: 0,
      },
      this.runnerRpcTimeoutMs,
    );
  }
}
