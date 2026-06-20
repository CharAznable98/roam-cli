import type {
  ApiApplyPatch,
  ApiWriteFile,
  DirectoryCreateResult,
  FileContentResult,
  FileNode,
  FileTreeResult,
  FileWriteResult,
  PatchApplyResult,
  Session,
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

export interface DirectoryCreateInput {
  parentPath: string;
  name: string;
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
    const unavailable = this.#worktreeUnavailable(session);
    if (unavailable) {
      return unavailable;
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
    const unavailable = this.#worktreeUnavailable(session);
    if (unavailable) {
      return unavailable;
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
    const unavailable = this.#worktreeUnavailable(session);
    if (unavailable) {
      return unavailable;
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

  async readRunnerDirectoryTree(
    runnerId: string,
    query: FileTreeQuery,
  ): Promise<ServiceResult<{ result: FileTreeResult }>> {
    const runner = this.store.getRunner(runnerId);
    if (!runner) {
      return fail("runner_not_found");
    }

    const result = await this.rpc.requestRunner<FileTreeResult>(
      runnerId,
      {
        type: "readFileTree",
        requestId: newId("runner_directory"),
        sessionId: `runner-directory-${runnerId}`,
        cwd: runner.workspaceRoot,
        path: query.path,
        depth: query.depth,
      },
      this.runnerRpcTimeoutMs,
    );
    return ok({ result: { ...result, root: directoriesOnly(result.root) } });
  }

  async createRunnerDirectory(
    runnerId: string,
    input: DirectoryCreateInput,
  ): Promise<ServiceResult<{ result: DirectoryCreateResult }>> {
    const runner = this.store.getRunner(runnerId);
    if (!runner) {
      return fail("runner_not_found");
    }

    const result = await this.rpc.requestRunner<DirectoryCreateResult>(
      runnerId,
      {
        type: "createDirectory",
        requestId: newId("directory_create"),
        cwd: runner.workspaceRoot,
        parentPath: input.parentPath,
        name: input.name,
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
    const unavailable = this.#worktreeUnavailable(session);
    if (unavailable) {
      return unavailable;
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

  async validateRunnerDirectory(
    runnerId: string,
    directory: string,
  ): Promise<void> {
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

  #worktreeUnavailable(session: Session): ServiceResult<never> | undefined {
    return session.executionMode === "managed_worktree" &&
      (session.status === "pending" || session.worktreeDeletedAt)
      ? fail("worktree_not_available")
      : undefined;
  }
}

function directoriesOnly(node: FileNode): FileNode {
  if (node.type === "file") {
    return node;
  }
  return {
    ...node,
    ...(node.children === undefined
      ? {}
      : {
          children: node.children
            .filter((child) => child.type === "directory")
            .map(directoriesOnly),
        }),
  };
}
