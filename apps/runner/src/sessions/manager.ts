import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  AgentInputUnavailableError,
  AgentInputRejectedError,
  type AgentRuntimeEvent,
  type ArtifactDraft,
} from "@roamcli/agent-plugin-sdk";
import type {
  AgentKind,
  RunnerAttachmentRef,
  RunnerCommand,
  RunnerProfile,
  Session,
} from "@roamcli/shared/protocol";
import type { LoadedAgent } from "../agents/registry.js";
import { ApprovalTracker } from "../approvals/tracker.js";
import {
  UserInputAcceptanceRetryableError,
  UserInputRequestTracker,
} from "../input-requests/tracker.js";
import { buildArtifact } from "../persistence/artifacts.js";
import { InputDeliveryStore } from "../persistence/input-deliveries.js";
import {
  type StartDeliveryPayload,
  type StartDeliveryRecord,
  StartDeliveryStore,
} from "../persistence/start-deliveries.js";
import {
  isInside,
  resolveExistingPath,
  resolveWorkspaceCreationPath,
  resolveWorkspaceDirectory,
} from "../workspace/scope.js";
import { SessionAttachmentStore } from "./attachments.js";
import type { RunnerEventSink, RunningSession } from "./types.js";
import {
  type SessionGeneration,
  SessionWaitCoordinator,
} from "./wait-coordinator.js";
import { WorkspaceCommandHandler } from "./workspace-commands.js";

const execFileAsync = promisify(execFile);

export interface SessionManagerOptions {
  workspace: string;
  stateDir?: string;
  profile: RunnerProfile;
  agents: readonly LoadedAgent[];
  emit: RunnerEventSink;
  agentAcceptanceTimeoutMs?: number;
  /** @internal Deterministic process identity for receipt state-machine tests. */
  startDeliveryBootId?: string;
}

interface TerminalPublication {
  token: SessionGeneration;
  promise: Promise<void>;
  settle: () => void;
}

interface TerminalSignal {
  generation: number;
  published: Promise<void>;
  settle: () => void;
}

interface StableInputDelivery {
  sessionId: string;
  inputRequestId?: string;
  contentHash: string;
  ownership: Promise<"owned" | "not_owned">;
}

const MAX_STABLE_INPUT_DELIVERIES = 1_024;
const DEFAULT_AGENT_ACCEPTANCE_TIMEOUT_MS = 25_000;

class AgentAcceptanceTimeoutError extends Error {
  public constructor(operation: "start" | "input") {
    super(`Agent ${operation} acceptance timed out`);
    this.name = "AgentAcceptanceTimeoutError";
  }
}

export class SessionManager {
  readonly #workspace: string;
  readonly #attachments: SessionAttachmentStore;
  readonly #profile: RunnerProfile;
  readonly #agents: Map<AgentKind, LoadedAgent>;
  readonly #emit: RunnerEventSink;
  readonly #waits: SessionWaitCoordinator;
  readonly #approvals: ApprovalTracker;
  readonly #userInputs: UserInputRequestTracker;
  readonly #workspaceCommands: WorkspaceCommandHandler;
  readonly #inputDeliveryStore: InputDeliveryStore;
  readonly #startDeliveryStore: StartDeliveryStore;
  readonly #agentAcceptanceTimeoutMs: number;
  readonly #bootId: string;
  readonly #sessions = new Map<string, RunningSession>();
  readonly #sessionGenerations = new Map<string, SessionGeneration>();
  readonly #startingSessionIds = new Set<string>();
  readonly #activeSessionCwds = new Map<string, string>();
  readonly #terminalPublications = new Map<string, TerminalPublication>();
  readonly #terminalSignals = new Map<string, TerminalSignal>();
  readonly #stableInputDeliveries = new Map<string, StableInputDelivery>();
  #startDeliveryTail = Promise.resolve();

  public constructor(options: SessionManagerOptions) {
    this.#workspace = options.workspace;
    this.#bootId = options.startDeliveryBootId ?? randomUUID();
    const stateDir = options.stateDir ?? join(this.#workspace, ".roam-runner");
    this.#attachments = new SessionAttachmentStore(stateDir);
    this.#inputDeliveryStore = new InputDeliveryStore(stateDir);
    this.#startDeliveryStore = new StartDeliveryStore(stateDir);
    this.#agentAcceptanceTimeoutMs =
      options.agentAcceptanceTimeoutMs ?? DEFAULT_AGENT_ACCEPTANCE_TIMEOUT_MS;
    this.#profile = options.profile;
    this.#agents = new Map(
      options.agents.map((agent) => [agent.capability.kind, agent]),
    );
    this.#emit = options.emit;
    this.#waits = new SessionWaitCoordinator(this.#emit);
    this.#approvals = new ApprovalTracker({
      emit: this.#emit,
      waits: this.#waits,
    });
    this.#userInputs = new UserInputRequestTracker({
      emit: this.#emit,
      waits: this.#waits,
    });
    this.#workspaceCommands = new WorkspaceCommandHandler({
      workspace: this.#workspace,
      emit: this.#emit,
      getSessionCwd: (sessionId, cwd) => this.#getSessionCwd(sessionId, cwd),
    });
  }

  public async handle(command: RunnerCommand): Promise<void> {
    switch (command.type) {
      case "startSession":
        if (
          command.requestId !== undefined &&
          command.deliveryId !== undefined
        ) {
          await this.#handleStableStart({
            ...command,
            requestId: command.requestId,
            deliveryId: command.deliveryId,
          });
          return;
        }
        await this.start(
          command.session,
          command.prompt,
          command.resumeThreadId,
          command.attachments,
        );
        return;
      case "deliverInput":
        this.deliverInput(command.sessionId, command.content);
        return;
      case "checkSessionStatus":
        await this.#checkSessionStatus(command);
        return;
      case "listAgentSkills":
        await this.#listAgentSkills(command);
        return;
      case "listAgentRuntimeConfigOptions":
        await this.#listAgentRuntimeConfigOptions(command);
        return;
      case "searchWorkspacePaths":
        await this.#workspaceCommands.searchWorkspacePaths(command);
        return;
      case "writeSessionAttachments":
        try {
          await this.#emit({
            type: "attachmentWriteResult",
            result: await this.#attachments.writeSessionAttachments(
              command.requestId,
              command.sessionId,
              command.attachments,
            ),
          });
        } catch (error: unknown) {
          await this.#emitCommandError(
            command.requestId,
            command.sessionId,
            error,
          );
        }
        return;
      case "readSessionAttachment":
        try {
          await this.#emit({
            type: "attachmentContentResult",
            result: await this.#attachments.readSessionAttachment(
              command.requestId,
              command.sessionId,
              command.attachmentId,
              command.runnerStoragePath,
              command.maxBytes,
            ),
          });
        } catch (error: unknown) {
          await this.#emitCommandError(
            command.requestId,
            command.sessionId,
            error,
          );
        }
        return;
      case "deleteSessionAttachments":
        try {
          await this.#emit({
            type: "attachmentDeleteResult",
            result: await this.#attachments.deleteSessionAttachments(
              command.requestId,
              command.sessionId,
              command.attachments,
            ),
          });
        } catch (error: unknown) {
          await this.#emitCommandError(
            command.requestId,
            command.sessionId,
            error,
          );
        }
        return;
      case "readFileTree":
        await this.#workspaceCommands.readFileTree(command);
        return;
      case "readFileContent":
        await this.#workspaceCommands.readFileContent(command);
        return;
      case "writeFileContent":
        await this.#workspaceCommands.writeFileContent(command);
        return;
      case "createDirectory":
        await this.#workspaceCommands.createDirectory(command);
        return;
      case "applyPatch":
        await this.#workspaceCommands.applyPatch(command);
        return;
      case "gitStatus":
        await this.#workspaceCommands.readGitStatus(command);
        return;
      case "gitFileDiff":
        await this.#workspaceCommands.readGitFileDiff(command);
        return;
      case "gitBlame":
        await this.#workspaceCommands.readGitBlame(command);
        return;
      case "gitCommitPage":
        await this.#workspaceCommands.readGitCommitPage(command);
        return;
      case "gitCommitFiles":
        await this.#workspaceCommands.readGitCommitFiles(command);
        return;
      case "gitBranchList":
        await this.#workspaceCommands.readGitBranches(command);
        return;
      case "gitInit":
        await this.#workspaceCommands.initGitRepository(command);
        return;
      case "gitStagePaths":
        await this.#workspaceCommands.stageGitPaths(command);
        return;
      case "gitUnstagePaths":
        await this.#workspaceCommands.unstageGitPaths(command);
        return;
      case "gitDiscardPaths":
        await this.#workspaceCommands.discardGitPaths(command);
        return;
      case "gitCommit":
        await this.#workspaceCommands.commitGitChanges(command);
        return;
      case "gitRemoteOperation":
        await this.#workspaceCommands.runGitRemoteOperation(command);
        return;
      case "gitRemoveWorktree":
        await this.#workspaceCommands.removeGitWorktree(command);
        return;
      case "resolveApproval":
        this.resolveApproval(command.approvalId, command.approved);
        return;
      case "resolveUserInput":
        await this.resolveUserInput(
          command.sessionId,
          command.content,
          command.inputRequestId,
        );
        return;
      case "controlSignal":
        this.control(command.sessionId, command.signal);
        return;
    }
  }

  public async start(
    session: Session,
    prompt: string,
    resumeThreadId?: string,
    attachments: readonly RunnerAttachmentRef[] = [],
    onClaimed?: () => Promise<void>,
  ): Promise<void> {
    await this.#waitForTerminalPublication(session.id);
    if (
      this.#sessions.has(session.id) ||
      this.#startingSessionIds.has(session.id)
    ) {
      await this.#emit({
        type: "error",
        sessionId: session.id,
        message: "Session is already running",
        code: "SESSION_EXISTS",
      });
      return;
    }

    const agent = this.#agents.get(session.agent);
    if (agent === undefined) {
      await this.#emit({
        type: "error",
        sessionId: session.id,
        message: `Unsupported agent: ${session.agent}`,
        code: "UNSUPPORTED_AGENT",
      });
      return;
    }

    this.#startingSessionIds.add(session.id);
    let failureCode: "INVALID_CWD" | "SPAWN_ERROR" = "INVALID_CWD";
    let token: SessionGeneration | undefined;
    let agentSession: RunningSession["agentSession"] | undefined;
    try {
      const cwd = await this.#prepareExecutionFolder(session);
      failureCode = "SPAWN_ERROR";
      token = this.#waits.begin(session.id);
      this.#registerTerminalSignal(token);
      const agentAttachments = await Promise.all(
        attachments.map(async (attachment) => ({
          kind: attachment.kind,
          name: attachment.name,
          mimeType: attachment.mimeType,
          localPath: await this.#attachments.localPathFor(
            session.id,
            attachment.id,
            attachment.runnerStoragePath,
          ),
        })),
      );
      agentSession = agent.definition.createSession({
        profile: this.#profile,
        env: process.env,
        session,
        cwd,
        prompt,
        attachments: agentAttachments,
        emit: (event) => this.#handleAgentEvent(token!, event),
        requestApproval: (draft) =>
          this.#approvals.request(token!, session, draft),
        requestUserInput: (draft) =>
          this.#userInputs.request(
            token!,
            { id: session.id, agent: session.agent },
            draft,
          ),
        ...(resumeThreadId ? { resumeThreadId } : {}),
      });
      const running: RunningSession = {
        session: { ...session, cwd },
        agentSession,
        stopRequested: false,
      };
      this.#sessions.set(session.id, running);
      this.#sessionGenerations.set(session.id, token);
      this.#activeSessionCwds.set(session.id, cwd);

      await this.#waits.syncStatus(token);
      const agentStart = agentSession.start();
      // Persistence can fsync before we await the lifecycle promise. Attach a
      // handler immediately so a fast agent failure is never reported as an
      // unhandled rejection; awaiting the original promise still propagates it.
      void Promise.resolve(agentStart).catch(() => undefined);
      await this.#withAgentAcceptanceDeadline(agentStart, "start");
      await onClaimed?.();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const shouldReportFailure =
        token === undefined || this.#waits.isActive(token);
      const terminalPublication =
        token === undefined ? undefined : this.#beginTerminalPublication(token);
      if (token === undefined) {
        this.#sessions.delete(session.id);
        this.#activeSessionCwds.delete(session.id);
      }
      if (agentSession !== undefined) {
        if (error instanceof AgentAcceptanceTimeoutError) {
          void Promise.resolve()
            .then(() => agentSession?.close())
            .catch(() => undefined);
        } else {
          await Promise.resolve()
            .then(() => agentSession?.close())
            .catch(() => undefined);
        }
      }
      if (!shouldReportFailure) {
        if (terminalPublication && !terminalPublication.owner) {
          await terminalPublication.publication.promise;
        }
        return;
      }
      await this.#emitSafely({
        type: "error",
        sessionId: session.id,
        message,
        code:
          error instanceof AgentAcceptanceTimeoutError
            ? "AGENT_ACCEPTANCE_TIMEOUT"
            : failureCode,
      });
      if (token === undefined) {
        // Folder preparation happens before a wait generation exists, but the
        // server still needs a terminal event for legacy/non-durable starts.
        // Without it, an INVALID_CWD or managed-worktree setup failure leaves
        // the server-side session permanently pending.
        await this.#emitSafely({
          type: "sessionStatus",
          sessionId: session.id,
          status: "failed",
        });
      }
      if (failureCode === "SPAWN_ERROR") {
        if (terminalPublication?.owner) {
          await this.#completeTerminalPublication(
            terminalPublication.publication,
            "failed",
            true,
          );
        } else {
          await terminalPublication?.publication.promise;
        }
      }
      return;
    } finally {
      this.#startingSessionIds.delete(session.id);
    }
  }

  async #handleStableStart(
    command: Extract<RunnerCommand, { type: "startSession" }> & {
      requestId: string;
      deliveryId: string;
    },
  ): Promise<void> {
    const operation = this.#startDeliveryTail.then(() =>
      this.#processStableStart(command),
    );
    this.#startDeliveryTail = operation.catch(() => undefined);
    await operation;
  }

  async #processStableStart(
    command: Extract<RunnerCommand, { type: "startSession" }> & {
      requestId: string;
      deliveryId: string;
    },
  ): Promise<void> {
    await this.#waitForTerminalPublication(command.session.id);
    const payload = startDeliveryPayload(command);
    const payloadHash = hashStartDeliveryPayload(payload);
    const existing = await this.#startDeliveryStore.get(command.deliveryId);
    if (existing !== undefined) {
      if (existing.payloadHash !== payloadHash) {
        await this.#emit({
          type: "error",
          requestId: command.requestId,
          sessionId: command.session.id,
          message: `Start delivery payload conflicts with an existing receipt: ${command.deliveryId}`,
          code: "START_DELIVERY_CONFLICT",
        });
        return;
      }
      if (existing.state === "launching") {
        if (existing.bootId !== this.#bootId) {
          // The previous process may have exited after durably recording the
          // launch attempt but before the agent accepted the prompt. Nothing
          // in this boot owns that attempt, so an explicit server retry may
          // safely launch it again. Same-boot retries remain suppressed below
          // to avoid delivering the prompt twice to an in-flight agent.
          await this.#launchAcceptedStart(existing, command.requestId);
          return;
        }
        const notOwned: StartDeliveryRecord = {
          ...existing,
          state: "not_owned",
        };
        await this.#startDeliveryStore.put(notOwned);
        await this.#emitStartReceipt(command.requestId, notOwned, "not_owned");
        return;
      }
      if (existing.state === "launched") {
        if (existing.bootId === this.#bootId) {
          await this.#emitStartReceipt(command.requestId, existing, "owned");
          return;
        }
        // A launched receipt only proves that the agent accepted the prompt in
        // the boot that wrote it. After a runner restart that process is gone,
        // so claiming ownership would let the server finalize a ghost start.
        // An explicit retry authorizes this boot to safely launch it again.
        await this.#launchAcceptedStart(existing, command.requestId);
        return;
      }
      if (existing.state === "completed") {
        await this.#emitStartReceipt(command.requestId, existing, "owned");
        return;
      }
      if (existing.state === "not_owned") {
        await this.#emitStartReceipt(command.requestId, existing, "not_owned");
        return;
      }
      await this.#launchAcceptedStart(existing, command.requestId);
      return;
    }

    const accepted: StartDeliveryRecord = {
      deliveryId: command.deliveryId,
      payloadHash,
      payload,
      state: "accepted",
    };
    if (this.#isSessionActive(command.session.id)) {
      const notOwned: StartDeliveryRecord = {
        ...accepted,
        state: "not_owned",
      };
      await this.#startDeliveryStore.put(notOwned);
      await this.#emitStartReceipt(command.requestId, notOwned, "not_owned");
      return;
    }
    await this.#startDeliveryStore.put(accepted);
    await this.#launchAcceptedStart(accepted, command.requestId);
  }

  async #launchAcceptedStart(
    record: StartDeliveryRecord,
    receiptRequestId: string,
  ): Promise<void> {
    const launching: StartDeliveryRecord = {
      ...record,
      state: "launching",
      bootId: this.#bootId,
    };
    await this.#startDeliveryStore.put(launching);
    let claimed = false;
    let resolveReceipt!: () => void;
    let rejectReceipt!: (error: unknown) => void;
    const receipt = new Promise<void>((resolve, reject) => {
      resolveReceipt = resolve;
      rejectReceipt = reject;
    });
    const started = this.start(
      record.payload.session,
      record.payload.prompt,
      record.payload.resumeThreadId,
      record.payload.attachments,
      async () => {
        claimed = true;
        let launched: StartDeliveryRecord;
        try {
          launched = {
            ...launching,
            state: "launched",
            bootId: this.#bootId,
          };
          await this.#startDeliveryStore.put(launched);
        } catch (error: unknown) {
          rejectReceipt(error);
          throw error;
        }
        try {
          await this.#emitStartReceipt(receiptRequestId, launched, "owned");
          resolveReceipt();
        } catch (error: unknown) {
          // The durable launched state remains authoritative. A reconnect can
          // retry the receipt without aborting an agent that already accepted
          // the prompt.
          rejectReceipt(error);
        }
      },
    );
    void started
      .then(async () => {
        if (claimed) {
          await this.#startDeliveryStore.put({
            ...record,
            state: "completed",
            bootId: this.#bootId,
          });
          return;
        }
        const notOwned: StartDeliveryRecord = {
          ...launching,
          state: "not_owned",
        };
        await this.#startDeliveryStore.put(notOwned);
        await this.#emitStartReceipt(receiptRequestId, notOwned, "not_owned");
        resolveReceipt();
      })
      .catch((error: unknown) => {
        rejectReceipt(error);
        void this.#emitSafely({
          type: "error",
          sessionId: record.payload.session.id,
          code: "START_RECEIPT_PERSISTENCE_ERROR",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    await receipt;
  }

  async #emitStartReceipt(
    requestId: string,
    record: StartDeliveryRecord,
    ownership: "owned" | "not_owned",
  ): Promise<void> {
    await this.#emit({
      type: "sessionStartResult",
      result: {
        requestId,
        sessionId: record.payload.session.id,
        deliveryId: record.deliveryId,
        ownership,
      },
    });
  }

  async #listAgentSkills(
    command: Extract<RunnerCommand, { type: "listAgentSkills" }>,
  ): Promise<void> {
    const agent = this.#agents.get(command.agent);
    if (!agent?.definition.listSkills) {
      await this.#emit({
        type: "agentSkillListResult",
        result: {
          requestId: command.requestId,
          agent: command.agent,
          basePath: command.basePath,
          queriedAt: new Date().toISOString(),
          skills: [],
        },
      });
      return;
    }

    try {
      const skills = await agent.definition.listSkills({
        profile: this.#profile,
        env: process.env,
        workspace: this.#workspace,
        basePath: command.basePath,
      });
      await this.#emit({
        type: "agentSkillListResult",
        result: {
          requestId: command.requestId,
          agent: command.agent,
          basePath: command.basePath,
          queriedAt: new Date().toISOString(),
          skills: [...skills],
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#emit({
        type: "error",
        requestId: command.requestId,
        message,
        code: "SKILL_LIST_ERROR",
      });
    }
  }

  async #listAgentRuntimeConfigOptions(
    command: Extract<RunnerCommand, { type: "listAgentRuntimeConfigOptions" }>,
  ): Promise<void> {
    const agent = this.#agents.get(command.agent);
    if (!agent?.definition.listRuntimeConfigOptions) {
      await this.#emit({
        type: "agentRuntimeConfigOptionsResult",
        result: {
          requestId: command.requestId,
          agent: command.agent,
          basePath: command.basePath,
          queriedAt: new Date().toISOString(),
          models: [],
          allowCustomModel: false,
          reasoningEfforts: [],
          fastMode: { kind: "unsupported", supported: false },
        },
      });
      return;
    }

    try {
      const result = await agent.definition.listRuntimeConfigOptions({
        profile: this.#profile,
        env: process.env,
        workspace: this.#workspace,
        basePath: command.basePath,
      });
      await this.#emit({
        type: "agentRuntimeConfigOptionsResult",
        result: {
          ...result,
          requestId: command.requestId,
          agent: command.agent,
          basePath: command.basePath,
          queriedAt: result.queriedAt ?? new Date().toISOString(),
        },
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#emit({
        type: "agentRuntimeConfigOptionsResult",
        result: {
          requestId: command.requestId,
          agent: command.agent,
          basePath: command.basePath,
          queriedAt: new Date().toISOString(),
          models: [],
          allowCustomModel: false,
          reasoningEfforts: [],
          fastMode: { kind: "unsupported", supported: false },
          error: message,
        },
      });
    }
  }

  public deliverInput(sessionId: string, content: string): void {
    const running = this.#sessions.get(sessionId);
    if (running === undefined) {
      void this.#emit({
        type: "error",
        sessionId,
        message: "Session is not running",
        code: "SESSION_NOT_RUNNING",
      });
      return;
    }
    void Promise.resolve()
      .then(() => running.agentSession.deliverInput({ content }))
      .catch((error: unknown) => {
        void this.#emit({
          type: "error",
          sessionId,
          message: error instanceof Error ? error.message : String(error),
          code: "AGENT_INPUT_ERROR",
        });
      });
  }

  async #checkSessionStatus(
    command: Extract<RunnerCommand, { type: "checkSessionStatus" }>,
  ): Promise<void> {
    await this.#waitForTerminalPublication(command.sessionId);
    if (command.deliverInput === undefined) {
      await this.#emitSessionStatusCheckResult(command, {
        active: this.#isSessionActive(command.sessionId),
      });
      return;
    }

    if (command.deliverInput.deliveryId !== undefined) {
      const ownership = await this.#deliverStableInput(command.sessionId, {
        deliveryId: command.deliverInput.deliveryId,
        ...(command.deliverInput.inputRequestId === undefined
          ? {}
          : { inputRequestId: command.deliverInput.inputRequestId }),
        content: command.deliverInput.content,
      });
      await this.#emitSessionStatusCheckResult(command, {
        active: this.#isSessionActive(command.sessionId),
        inputReceipt: {
          deliveryId: command.deliverInput.deliveryId,
          ownership,
        },
      });
      return;
    }

    const running = this.#sessions.get(command.sessionId);
    const token = this.#sessionGenerations.get(command.sessionId);
    if (running === undefined || token === undefined) {
      await this.#emitSessionStatusCheckResult(command, {
        active: this.#isSessionActive(command.sessionId),
        inputDelivered: false,
      });
      return;
    }

    try {
      await this.#withAgentAcceptanceDeadline(
        running.agentSession.deliverInput({
          content: command.deliverInput.content,
        }),
        "input",
      );
      const publication = this.#terminalPublications.get(command.sessionId);
      if (publication?.token.generation === token.generation) {
        await publication.promise;
      }
      const active = this.#isCurrentGeneration(token, running);
      await this.#emitSessionStatusCheckResult(command, {
        active,
        inputDelivered: true,
      });
    } catch (error: unknown) {
      if (error instanceof AgentAcceptanceTimeoutError) {
        await this.#terminateTimedOutSession(token, running, error);
      }
      if (
        error instanceof AgentInputUnavailableError &&
        !this.#isCurrentGeneration(token, running)
      ) {
        const publication = this.#terminalPublications.get(token.sessionId);
        if (publication?.token.generation === token.generation) {
          await publication.promise;
        }
      }
      await this.#emitSessionStatusCheckResult(command, {
        active: this.#isCurrentGeneration(token, running),
        inputDelivered: false,
      });
    }
  }

  async #deliverStableInput(
    sessionId: string,
    input: {
      deliveryId: string;
      inputRequestId?: string;
      content: string;
    },
  ): Promise<"owned" | "not_owned"> {
    const contentHash = createHash("sha256")
      .update(input.content)
      .digest("hex");
    const existing = this.#stableInputDeliveries.get(input.deliveryId);
    if (existing !== undefined) {
      if (
        existing.sessionId !== sessionId ||
        existing.inputRequestId !== input.inputRequestId ||
        existing.contentHash !== contentHash
      ) {
        return "not_owned";
      }
      return existing.ownership;
    }

    const persisted = await this.#inputDeliveryStore.get(input.deliveryId);
    if (persisted !== undefined) {
      if (
        persisted.sessionId !== sessionId ||
        persisted.inputRequestId !== input.inputRequestId ||
        persisted.contentHash !== contentHash
      ) {
        return "not_owned";
      }
      return persisted.ownership;
    }

    const concurrent = this.#stableInputDeliveries.get(input.deliveryId);
    if (concurrent !== undefined) {
      if (
        concurrent.sessionId !== sessionId ||
        concurrent.inputRequestId !== input.inputRequestId ||
        concurrent.contentHash !== contentHash
      ) {
        return "not_owned";
      }
      return concurrent.ownership;
    }

    let ownership: Promise<"owned" | "not_owned">;
    ownership = this.#performStableInputDelivery(sessionId, input)
      .then(async (result) => {
        await this.#inputDeliveryStore.put({
          deliveryId: input.deliveryId,
          sessionId,
          ...(input.inputRequestId === undefined
            ? {}
            : { inputRequestId: input.inputRequestId }),
          contentHash,
          ownership: result,
        });
        return result;
      })
      .catch((error: unknown) => {
        if (
          error instanceof UserInputAcceptanceRetryableError ||
          error instanceof AgentInputRejectedError
        ) {
          const current = this.#stableInputDeliveries.get(input.deliveryId);
          if (current?.ownership === ownership) {
            this.#stableInputDeliveries.delete(input.deliveryId);
          }
        }
        if (error instanceof AgentInputRejectedError) return "not_owned";
        throw error;
      });
    this.#stableInputDeliveries.set(input.deliveryId, {
      sessionId,
      ...(input.inputRequestId === undefined
        ? {}
        : { inputRequestId: input.inputRequestId }),
      contentHash,
      ownership,
    });
    while (this.#stableInputDeliveries.size > MAX_STABLE_INPUT_DELIVERIES) {
      const oldest = this.#stableInputDeliveries.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) {
        break;
      }
      this.#stableInputDeliveries.delete(oldest);
    }
    return ownership;
  }

  async #performStableInputDelivery(
    sessionId: string,
    input: { deliveryId: string; inputRequestId?: string; content: string },
  ): Promise<"owned" | "not_owned"> {
    if (input.inputRequestId !== undefined) {
      return (await this.#userInputs.resolve(
        sessionId,
        input.inputRequestId,
        input.content,
      ))
        ? "owned"
        : "not_owned";
    }

    const running = this.#sessions.get(sessionId);
    const token = this.#sessionGenerations.get(sessionId);
    if (running === undefined || token === undefined) {
      return "not_owned";
    }
    try {
      await this.#withAgentAcceptanceDeadline(
        running.agentSession.deliverInput({
          content: input.content,
          deliveryId: input.deliveryId,
        }),
        "input",
      );
      const publication = this.#terminalPublications.get(sessionId);
      if (publication?.token.generation === token.generation) {
        await publication.promise;
      }
      return "owned";
    } catch (error: unknown) {
      if (error instanceof AgentInputRejectedError) throw error;
      if (error instanceof AgentAcceptanceTimeoutError) {
        await this.#terminateTimedOutSession(token, running, error);
      }
      if (
        error instanceof AgentInputUnavailableError &&
        !this.#isCurrentGeneration(token, running)
      ) {
        const publication = this.#terminalPublications.get(sessionId);
        if (publication?.token.generation === token.generation) {
          await publication.promise;
        }
      }
      return "not_owned";
    }
  }

  async #terminateTimedOutSession(
    token: SessionGeneration,
    running: RunningSession,
    error: AgentAcceptanceTimeoutError,
  ): Promise<void> {
    if (!this.#isCurrentGeneration(token, running)) {
      return;
    }
    void Promise.resolve()
      .then(() => running.agentSession.close())
      .catch(() => undefined);
    await this.#emitSafely({
      type: "error",
      sessionId: token.sessionId,
      message: error.message,
      code: "AGENT_ACCEPTANCE_TIMEOUT",
    });
    const started = this.#beginTerminalPublication(token);
    if (started?.owner) {
      await this.#completeTerminalPublication(
        started.publication,
        "failed",
        true,
      );
    } else {
      await started?.publication.promise;
    }
  }

  async #withAgentAcceptanceDeadline<T>(
    operation: PromiseLike<T> | T,
    kind: "start" | "input",
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new AgentAcceptanceTimeoutError(kind));
      }, this.#agentAcceptanceTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([Promise.resolve(operation), timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  public async readFileTree(
    requestId: string,
    sessionId: string,
    cwd: string | undefined,
    path = ".",
    depth = 3,
  ): Promise<void> {
    await this.#workspaceCommands.readFileTree({
      type: "readFileTree",
      requestId,
      sessionId,
      ...(cwd === undefined ? {} : { cwd }),
      path,
      depth,
    });
  }

  public async readFileContent(
    requestId: string,
    sessionId: string,
    cwd: string | undefined,
    path: string,
    maxBytes = 256 * 1024,
  ): Promise<void> {
    await this.#workspaceCommands.readFileContent({
      type: "readFileContent",
      requestId,
      sessionId,
      ...(cwd === undefined ? {} : { cwd }),
      path,
      maxBytes,
    });
  }

  public async writeFileContent(
    requestId: string,
    sessionId: string,
    cwd: string | undefined,
    path: string,
    content: string,
  ): Promise<void> {
    await this.#workspaceCommands.writeFileContent({
      type: "writeFileContent",
      requestId,
      sessionId,
      ...(cwd === undefined ? {} : { cwd }),
      path,
      content,
    });
  }

  public async applyPatch(
    command: Extract<RunnerCommand, { type: "applyPatch" }>,
  ): Promise<void> {
    await this.#workspaceCommands.applyPatch(command);
  }

  public resolveApproval(approvalId: string, approved: boolean): void {
    this.#approvals.resolve(approvalId, approved);
  }

  public async resolveUserInput(
    sessionId: string,
    content: string,
    inputRequestId?: string,
  ): Promise<void> {
    await this.#userInputs.resolve(sessionId, inputRequestId, content);
  }

  public control(
    sessionId: string,
    signal: "interrupt" | "stop" | "resume",
  ): void {
    const running = this.#sessions.get(sessionId);
    if (running === undefined) {
      void this.#emit({
        type: "error",
        sessionId,
        message: "Session is not running",
        code: "SESSION_NOT_RUNNING",
      });
      return;
    }
    if (signal === "interrupt") {
      void Promise.resolve()
        .then(() => running.agentSession.control("interrupt"))
        .catch((error: unknown) => {
          void this.#emit({
            type: "error",
            sessionId,
            message: error instanceof Error ? error.message : String(error),
            code: "AGENT_CONTROL_ERROR",
          });
        });
    } else if (signal === "stop") {
      running.stopRequested = true;
      const token = this.#sessionGenerations.get(sessionId);
      void Promise.resolve()
        .then(() => running.agentSession.control("stop"))
        .catch((error: unknown) => {
          void this.#emit({
            type: "error",
            sessionId,
            message: error instanceof Error ? error.message : String(error),
            code: "AGENT_CONTROL_ERROR",
          });
        });
      running.stopTimer ??= setTimeout(() => {
        void Promise.resolve()
          .then(() => running.agentSession.close())
          .then(async () => {
            if (token && this.#isCurrentGeneration(token, running)) {
              await this.#publishTerminal(token, "stopped");
            }
          })
          .catch(() => undefined);
      }, 1500);
      running.stopTimer.unref?.();
    } else {
      void Promise.resolve()
        .then(() => running.agentSession.control("resume"))
        .catch((error: unknown) => {
          void this.#emit({
            type: "error",
            sessionId,
            message: error instanceof Error ? error.message : String(error),
            code: "AGENT_CONTROL_ERROR",
          });
        });
    }
  }

  async #emitCommandError(
    requestId: string,
    sessionId: string,
    error: unknown,
  ): Promise<void> {
    await this.#emit({
      type: "error",
      requestId,
      sessionId,
      message: error instanceof Error ? error.message : String(error),
      code: "ATTACHMENT_ERROR",
    });
  }

  async #handleAgentEvent(
    token: SessionGeneration,
    event: AgentRuntimeEvent,
  ): Promise<void> {
    if (!this.#waits.isActive(token)) {
      return;
    }
    const sessionId = token.sessionId;
    switch (event.type) {
      case "status":
        {
          if (isTerminalStatus(event.status)) {
            await this.#publishTerminal(token, event.status);
          } else if (
            event.status === "running" ||
            this.#waits.hasWaits(token)
          ) {
            await this.#waits.syncStatus(token);
          } else {
            await this.#waits.emitStatus(token, event.status);
          }
        }
        return;
      case "thread":
        await this.#emit({
          type: "sessionThread",
          sessionId,
          threadId: event.threadId,
        });
        return;
      case "assistantOutput":
        await this.#emit({
          type: "assistantOutput",
          sessionId,
          outputId: event.outputId,
          ...(event.content === undefined ? {} : { content: event.content }),
          mode: event.mode,
          done: event.done,
          encrypted: event.encrypted ?? false,
        });
        return;
      case "activity":
        {
          const running = this.#sessions.get(sessionId);
          await this.#emit({
            type: "agentActivity",
            sessionId,
            agent: running?.session.agent ?? "unknown",
            kind: event.kind,
            label: event.label,
          });
        }
        return;
      case "approval":
        {
          const running = this.#sessions.get(sessionId);
          if (running !== undefined) {
            void this.#approvals
              .request(token, running.session, event.draft)
              .catch(() => undefined);
          }
        }
        return;
      case "artifact":
        await this.#emitArtifact(sessionId, event.draft);
        return;
      case "error":
        await this.#emit({
          type: "error",
          sessionId,
          message: event.message,
          ...(event.code === undefined ? {} : { code: event.code }),
        });
        return;
    }
  }

  async #emitArtifact(sessionId: string, draft: ArtifactDraft): Promise<void> {
    const cwd = this.#activeSessionCwds.get(sessionId);
    if (cwd === undefined) {
      await this.#emit({
        type: "error",
        sessionId,
        message: "Session cwd is unavailable for artifact",
        code: "ARTIFACT_ERROR",
      });
      return;
    }
    try {
      const artifact = await buildArtifact(
        sessionId,
        (
          await resolveExistingPath(
            { workspace: this.#workspace, sessionCwd: cwd },
            draft.path,
          )
        ).realPath,
        draft.kind ?? "file",
        draft.mimeType ?? "application/octet-stream",
      );
      await this.#emit({ type: "artifactCreated", artifact });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#emit({
        type: "error",
        sessionId,
        message,
        code: "ARTIFACT_ERROR",
      });
    }
  }

  #finishRunningSession(token: SessionGeneration): void {
    const sessionId = token.sessionId;
    this.#waits.finish(token);
    this.#approvals.clear(sessionId, token);
    this.#userInputs.clear(sessionId, token);
    const currentToken = this.#sessionGenerations.get(sessionId);
    if (currentToken?.generation !== token.generation) {
      return;
    }
    const running = this.#sessions.get(sessionId);
    this.#sessions.delete(sessionId);
    this.#sessionGenerations.delete(sessionId);
    this.#activeSessionCwds.delete(sessionId);
    if (running?.stopTimer !== undefined) {
      clearTimeout(running.stopTimer);
    }
  }

  #registerTerminalSignal(token: SessionGeneration): void {
    let settle!: () => void;
    this.#terminalSignals.set(token.sessionId, {
      generation: token.generation,
      published: new Promise<void>((resolve) => {
        settle = resolve;
      }),
      settle: () => settle(),
    });
  }

  #beginTerminalPublication(
    token: SessionGeneration,
  ): { publication: TerminalPublication; owner: boolean } | undefined {
    const existing = this.#terminalPublications.get(token.sessionId);
    if (existing?.token.generation === token.generation) {
      return { publication: existing, owner: false };
    }
    const signal = this.#terminalSignals.get(token.sessionId);
    if (signal?.generation !== token.generation) {
      return undefined;
    }
    let settle!: () => void;
    const publication: TerminalPublication = {
      token,
      promise: new Promise<void>((resolve) => {
        settle = resolve;
      }),
      settle: () => settle(),
    };
    this.#terminalPublications.set(token.sessionId, publication);
    this.#finishRunningSession(token);
    return { publication, owner: true };
  }

  async #publishTerminal(
    token: SessionGeneration,
    status: "completed" | "failed" | "stopped",
  ): Promise<void> {
    const started = this.#beginTerminalPublication(token);
    if (!started) {
      return;
    }
    if (!started.owner) {
      await started.publication.promise;
      return;
    }
    await this.#completeTerminalPublication(started.publication, status, false);
  }

  async #completeTerminalPublication(
    publication: TerminalPublication,
    status: "completed" | "failed" | "stopped",
    safely: boolean,
  ): Promise<void> {
    const event = {
      type: "sessionStatus" as const,
      sessionId: publication.token.sessionId,
      status,
    };
    try {
      if (safely) {
        await this.#emitSafely(event);
      } else {
        await this.#emit(event);
      }
    } finally {
      publication.settle();
      const current = this.#terminalPublications.get(
        publication.token.sessionId,
      );
      if (current === publication) {
        this.#terminalPublications.delete(publication.token.sessionId);
      }
      const signal = this.#terminalSignals.get(publication.token.sessionId);
      if (signal?.generation === publication.token.generation) {
        signal.settle();
        this.#terminalSignals.delete(publication.token.sessionId);
      }
    }
  }

  async #waitForTerminalPublication(sessionId: string): Promise<void> {
    // The Server exposes stopped optimistically. A continuation may arrive
    // before the agent has flushed its native session and published terminal.
    // Wait only for an explicitly stopping generation, not for active work.
    if (this.#sessions.get(sessionId)?.stopRequested) {
      await this.#terminalSignals.get(sessionId)?.published;
    }
    const publication = this.#terminalPublications.get(sessionId);
    await publication?.promise;
  }

  #isSessionActive(sessionId: string): boolean {
    return (
      this.#sessions.has(sessionId) || this.#startingSessionIds.has(sessionId)
    );
  }

  #isCurrentGeneration(
    token: SessionGeneration,
    running: RunningSession,
  ): boolean {
    const current = this.#sessionGenerations.get(token.sessionId);
    return (
      current?.generation === token.generation &&
      this.#sessions.get(token.sessionId) === running
    );
  }

  async #emitSessionStatusCheckResult(
    command: Extract<RunnerCommand, { type: "checkSessionStatus" }>,
    result: {
      active: boolean;
      inputDelivered?: boolean;
      inputReceipt?: {
        deliveryId: string;
        ownership: "owned" | "not_owned";
      };
    },
  ): Promise<void> {
    await this.#emit({
      type: "sessionStatusCheckResult",
      result: {
        requestId: command.requestId,
        sessionId: command.sessionId,
        active: result.active,
        ...(result.inputDelivered === undefined
          ? {}
          : { inputDelivered: result.inputDelivered }),
        ...(result.inputReceipt === undefined
          ? {}
          : { inputReceipt: result.inputReceipt }),
      },
    });
  }

  async #emitSafely(event: Parameters<RunnerEventSink>[0]): Promise<void> {
    await Promise.resolve()
      .then(() => this.#emit(event))
      .catch(() => undefined);
  }

  async #resolveCwd(cwd: string): Promise<string> {
    return resolveWorkspaceDirectory(this.#workspace, cwd);
  }

  async #prepareExecutionFolder(session: Session): Promise<string> {
    if (session.executionMode !== "managed_worktree") {
      return this.#resolveCwd(session.executionFolder ?? session.cwd);
    }

    const projectCwd = await this.#resolveCwd(session.cwd);
    const worktreeCwd = await resolveWorkspaceCreationPath(
      this.#workspace,
      session.executionFolder,
    );
    const existing = await stat(worktreeCwd).catch((error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    });
    if (existing !== undefined) {
      if (!existing.isDirectory()) {
        throw new Error(
          `Managed worktree path is not a directory: ${session.executionFolder}`,
        );
      }
      await this.#assertManagedWorktree(projectCwd, worktreeCwd);
      return worktreeCwd;
    }
    const branchName = session.gitBranchName;
    if (branchName === undefined) {
      throw new Error("Managed worktree sessions require a git branch name");
    }
    const baseRef = session.gitBaseRef ?? "HEAD";
    await execFileAsync("git", [
      "-c",
      "core.longpaths=true",
      "-C",
      projectCwd,
      "rev-parse",
      "--verify",
      `${baseRef}^{commit}`,
    ]);
    await mkdir(dirname(worktreeCwd), { recursive: true });
    await execFileAsync("git", [
      "-c",
      "core.longpaths=true",
      "-C",
      projectCwd,
      "worktree",
      "add",
      "-b",
      branchName,
      worktreeCwd,
      baseRef,
    ]);
    return this.#resolveCwd(session.executionFolder);
  }

  async #assertManagedWorktree(
    projectCwd: string,
    worktreeCwd: string,
  ): Promise<void> {
    const [workspaceRealPath, projectRealPath, worktreeRealPath] =
      await Promise.all([
        realpath(this.#workspace),
        realpath(projectCwd),
        realpath(worktreeCwd),
      ]);
    if (
      !isInside(workspaceRealPath, projectRealPath) ||
      !isInside(workspaceRealPath, worktreeRealPath)
    ) {
      throw new Error(
        `Managed worktree path escapes workspace: ${worktreeCwd}`,
      );
    }
    if (projectRealPath === worktreeRealPath) {
      throw new Error(
        `Managed worktree path points at the project directory: ${worktreeCwd}`,
      );
    }

    const inside = await execFileAsync("git", [
      "-c",
      "core.longpaths=true",
      "-C",
      worktreeCwd,
      "rev-parse",
      "--is-inside-work-tree",
    ])
      .then(({ stdout }) => String(stdout).trim())
      .catch(() => "false");
    if (inside !== "true") {
      throw new Error(
        `Managed worktree path is not a git worktree: ${worktreeCwd}`,
      );
    }

    const { stdout } = await execFileAsync("git", [
      "-c",
      "core.longpaths=true",
      "-C",
      projectCwd,
      "worktree",
      "list",
      "--porcelain",
    ]);
    const worktreePaths = String(stdout)
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
    const realWorktreePaths = await Promise.all(
      worktreePaths.map((path) => realpath(path).catch(() => path)),
    );
    if (!realWorktreePaths.includes(worktreeRealPath)) {
      throw new Error(
        `Managed worktree path is not registered for the project: ${worktreeCwd}`,
      );
    }
  }

  async #getSessionCwd(
    sessionId: string,
    cwd: string | undefined,
  ): Promise<string | undefined> {
    const existing = this.#activeSessionCwds.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    if (cwd === undefined) {
      return undefined;
    }
    return this.#resolveCwd(cwd);
  }
}

function startDeliveryPayload(
  command: Extract<RunnerCommand, { type: "startSession" }> & {
    requestId: string;
  },
): StartDeliveryPayload {
  return {
    requestId: command.requestId,
    session: command.session,
    prompt: command.prompt,
    ...(command.resumeThreadId === undefined
      ? {}
      : { resumeThreadId: command.resumeThreadId }),
    attachments: [...(command.attachments ?? [])],
  };
}

function hashStartDeliveryPayload(payload: StartDeliveryPayload): string {
  return createHash("sha256")
    .update(
      stableJson({
        session: payload.session,
        prompt: payload.prompt,
        resumeThreadId: payload.resumeThreadId ?? null,
        attachments: payload.attachments,
      }),
    )
    .digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isTerminalStatus(
  status: Session["status"],
): status is "completed" | "failed" | "stopped" {
  return status === "completed" || status === "failed" || status === "stopped";
}
