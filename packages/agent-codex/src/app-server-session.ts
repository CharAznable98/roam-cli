import {
  spawn as spawnChild,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  AgentInputUnavailableError,
  type AgentInput,
  type AgentLaunchAttachment,
  type AgentRuntimeEvent,
  type AgentSession,
  type AgentSessionContext,
  type ApprovalRequestDraft,
  type UserInputQuestion,
  type UserInputQuestionOption,
  type UserInputRequestDraft,
} from "@roamcli/agent-plugin-sdk";
import type {
  AgentActivityKind,
  RunnerProfile,
} from "@roamcli/shared/protocol";
import { CodexAppServerClient } from "./app-server-client.js";
import type {
  AskForApproval,
  AgentMessageDeltaNotification,
  CommandApprovalParams,
  FileChangeApprovalParams,
  ItemStartedNotification,
  ItemCompletedNotification,
  JsonRpcRequest,
  McpServerElicitationRequestParams,
  PermissionApprovalParams,
  SandboxPolicy,
  ThreadStatusChangedNotification,
  ThreadResponse,
  ToolRequestUserInputOption,
  ToolRequestUserInputParams,
  TurnNotification,
  TurnStartResponse,
  UserInput,
} from "./app-server-protocol.js";
import { asString, isRecord } from "./app-server-protocol.js";
import { parseTextDirectives, streamingDisplayText } from "./directives.js";

interface ApprovalDecision {
  approvalId: string;
  approved: boolean;
  signedAt: string;
  signature?: string;
}

interface CodexAppServerSessionOptions {
  command: string;
  args: readonly string[];
  context: AgentSessionContext;
}

interface QueuedInput {
  content: string;
  attachments?: readonly AgentLaunchAttachment[];
  steeringSettled?: Promise<void>;
  acceptance?: InputAcceptance;
}

interface InputAcceptance {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface AcceptedInputDelivery {
  content: string;
  promise: Promise<void>;
}

interface CodexActivitySummary {
  kind: AgentActivityKind;
  label: string;
}

const MAX_ACTIVITY_LABEL_LENGTH = 120;
const MAX_ACTIVITY_OBJECT_LENGTH = 80;
const MAX_STDERR_DIAGNOSTIC_LENGTH = 4096;

export class CodexAppServerSession implements AgentSession {
  readonly #command: string;
  readonly #args: readonly string[];
  readonly #context: AgentSessionContext;
  readonly #queue: QueuedInput[] = [];
  readonly #acceptedInputDeliveries = new Map<string, AcceptedInputDelivery>();
  readonly #outputPrefix = `codex-app-server-run-${randomUUID()}`;
  #child: ChildProcessWithoutNullStreams | undefined;
  #client: CodexAppServerClient | undefined;
  #threadId: string | undefined;
  #activeTurnId: string | undefined;
  #filterTurnId: string | undefined;
  #turnSequence = 0;
  #outputSequence = 0;
  #closed = false;
  #draining = false;
  #stopRequested = false;
  #interruptRequested = false;
  #interruptSent = false;
  #stoppedEmitted = false;
  #pendingTerminalStatus: "stopped" | undefined;
  #turnCompletedSuccessfully = false;
  #rootThreadIdle = false;
  readonly #threadIdleWaiters = new Set<() => void>();
  #turnDone:
    | {
        turnId: string | undefined;
        resolve: () => void;
        reject: (error: Error) => void;
      }
    | undefined;
  readonly #streamedOutputIds = new Set<string>();
  readonly #streamedAssistantOutputs = new Map<
    string,
    { rawText: string; emittedText: string }
  >();
  readonly #fileChangeItems = new Map<string, unknown>();
  readonly #commandExecutionItems = new Map<
    string,
    ItemStartedNotification["item"]
  >();
  readonly #activityStartedItems = new Set<string>();
  readonly #pendingDirectiveApprovals = new Set<Promise<void>>();
  #stderrDiagnostic = "";

  public constructor(options: CodexAppServerSessionOptions) {
    this.#command = options.command;
    this.#args = options.args;
    this.#context = options.context;
  }

  public async start(): Promise<void> {
    if (this.#closed || this.#stopRequested) {
      throw new AgentInputUnavailableError();
    }
    this.#child = spawnChild(this.#command, [...this.#args], {
      cwd: this.#context.cwd,
      env: this.#context.env,
      stdio: "pipe",
    });
    this.#child.on("close", (code, signal) => {
      const client = this.#client;
      const exitMessage = this.#appServerExitMessage(code, signal);
      client?.close(new Error(exitMessage));
      if (this.#closed || this.#stopRequested) {
        return;
      }
      if (this.#activeTurnId === undefined && this.#threadId === undefined) {
        return;
      }
      this.#fail(
        this.#activeTurnId === undefined
          ? this.#appServerExitMessage(
              code,
              signal,
              "before the next turn started",
            )
          : this.#appServerExitMessage(
              code,
              signal,
              "before the active turn completed",
            ),
      );
    });
    this.#child.on("error", (error) => {
      this.#fail(error.message);
    });
    this.#child.stderr.on("data", (chunk) =>
      this.#appendStderrDiagnostic(chunk),
    );
    this.#child.stderr.resume();

    this.#client = new CodexAppServerClient({
      child: this.#child,
      onNotification: (notification) =>
        this.#handleNotification(notification.method, notification.params),
      onRequest: (request) => this.#handleRequest(request),
      onParseError: (error) => this.#emitError(error.message),
    });

    try {
      await this.#initialize();
      await this.#openThread();
    } catch (error) {
      if (this.#closed || this.#stopRequested) {
        throw new AgentInputUnavailableError(
          error instanceof Error ? error.message : String(error),
        );
      }
      this.#closeAppServer("SIGTERM");
      throw error;
    }
    const acceptance = createInputAcceptance();
    this.#queue.unshift({
      content: this.#context.prompt,
      acceptance,
      ...(this.#context.attachments
        ? { attachments: this.#context.attachments }
        : {}),
    });
    this.#startDrain();
    await acceptance.promise;
  }

  public deliverInput(input: AgentInput): Promise<void> {
    if (
      this.#closed ||
      this.#stopRequested ||
      this.#pendingTerminalStatus !== undefined
    ) {
      throw new AgentInputUnavailableError();
    }
    if (input.deliveryId !== undefined) {
      const existing = this.#acceptedInputDeliveries.get(input.deliveryId);
      if (existing !== undefined) {
        if (existing.content !== input.content) {
          return Promise.reject(
            new AgentInputUnavailableError(
              "Input delivery ID was reused with different content",
            ),
          );
        }
        return existing.promise;
      }
      const promise = this.#acceptInput(input);
      this.#acceptedInputDeliveries.set(input.deliveryId, {
        content: input.content,
        promise,
      });
      return promise;
    }
    return this.#acceptInput(input);
  }

  async #acceptInput(input: AgentInput): Promise<void> {
    const acceptance = createInputAcceptance();
    if (
      this.#threadId &&
      this.#activeTurnId &&
      !this.#rootThreadIdle &&
      !this.#turnCompletedSuccessfully
    ) {
      let settleSteering!: () => void;
      const queued: QueuedInput = {
        content: input.content,
        acceptance,
        steeringSettled: new Promise<void>((resolve) => {
          settleSteering = resolve;
        }),
      };
      this.#queue.push(queued);
      try {
        await this.#steerTurn(input);
        const index = this.#queue.indexOf(queued);
        if (index >= 0) {
          this.#queue.splice(index, 1);
        }
        acceptance.resolve();
      } catch (error: unknown) {
        if (this.#closed || this.#stopRequested) {
          const unavailable = new AgentInputUnavailableError(
            error instanceof Error ? error.message : String(error),
          );
          acceptance.reject(unavailable);
          throw unavailable;
        }
        this.#startDrain();
      } finally {
        settleSteering();
      }
      return acceptance.promise;
    }
    this.#queue.push({ content: input.content, acceptance });
    if (this.#threadId) {
      this.#startDrain();
    }
    return acceptance.promise;
  }

  public async control(signal: "interrupt" | "stop" | "resume"): Promise<void> {
    if (signal === "resume") {
      return;
    }
    if (signal === "interrupt") {
      this.#interruptRequested = true;
      await this.#requestInterrupt();
      return;
    }
    if (signal === "stop") {
      this.#stopRequested = true;
      this.#closed = true;
      this.#rejectQueuedInputs(new AgentInputUnavailableError());
      this.#streamedAssistantOutputs.clear();
      this.#resolveThreadIdleWaiters();
      if (this.#threadId && this.#activeTurnId) {
        void this.#client
          ?.request("turn/interrupt", {
            threadId: this.#threadId,
            turnId: this.#activeTurnId,
          })
          .catch(() => undefined);
      }
      this.#child?.kill("SIGTERM");
      this.#client?.close();
      await this.#emitStopped();
    }
  }

  public close(): void {
    this.#closed = true;
    this.#rejectQueuedInputs(new AgentInputUnavailableError());
    this.#streamedAssistantOutputs.clear();
    this.#pendingTerminalStatus = undefined;
    this.#resolveThreadIdleWaiters();
    this.#client?.close();
    this.#child?.kill("SIGKILL");
  }

  async #initialize(): Promise<void> {
    await this.#request("initialize", {
      clientInfo: {
        name: "@roamcli/agent-codex",
        version: "1.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.#client?.notify("initialized");
  }

  async #openThread(): Promise<void> {
    const response = (await this.#request(
      this.#context.resumeThreadId ? "thread/resume" : "thread/start",
      {
        ...(this.#context.resumeThreadId
          ? { threadId: this.#context.resumeThreadId }
          : threadStartParamsForProfile(this.#context.profile)),
        ...runtimeThreadParams(this.#context.session.agentRuntimeConfig),
        cwd: this.#context.cwd,
      },
    )) as ThreadResponse;
    const threadId = response.thread?.id;
    if (!threadId) {
      throw new Error("Codex app-server did not return a thread id");
    }
    this.#threadId = threadId;
    await this.#emit({ type: "thread", threadId });
  }

  #startDrain(): void {
    if (this.#draining) {
      return;
    }
    this.#draining = true;
    void this.#drain()
      .catch((error: unknown) => {
        this.#fail(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this.#draining = false;
        if (!this.#closed && this.#queue.length > 0) {
          this.#startDrain();
        }
      });
  }

  async #drain(): Promise<void> {
    while (!this.#closed) {
      if (this.#pendingTerminalStatus === "stopped") {
        await this.#emitPendingTerminalStatus();
        return;
      }
      if (this.#queue.length === 0) {
        await this.#emitCompletedIfReady();
        return;
      }
      await this.#queue[0]?.steeringSettled;
      if (this.#closed) {
        return;
      }
      if (this.#queue.length === 0) {
        continue;
      }
      await this.#awaitRootThreadIdleBeforeNextTurn();
      if (this.#closed) {
        return;
      }
      const input = this.#queue.shift();
      if (input === undefined) {
        continue;
      }
      await this.#runTurn(input);
    }
  }

  async #runTurn(input: QueuedInput): Promise<void> {
    const threadId = this.#threadId;
    if (!threadId) {
      throw new Error("Cannot start a Codex turn before the thread is ready");
    }
    this.#turnSequence += 1;
    this.#interruptSent = false;
    this.#turnCompletedSuccessfully = false;
    this.#rootThreadIdle = false;
    this.#filterTurnId = undefined;
    this.#streamedOutputIds.clear();
    this.#streamedAssistantOutputs.clear();
    this.#activityStartedItems.clear();
    const turnDone = new Promise<void>((resolve, reject) => {
      this.#turnDone = {
        turnId: this.#activeTurnId,
        resolve,
        reject,
      };
    });
    void turnDone.catch(() => undefined);
    const currentTurnDone = this.#turnDone!;
    let response: TurnStartResponse;
    try {
      response = (await this.#request("turn/start", {
        threadId,
        cwd: this.#context.cwd,
        input: userInputFor(input),
        ...turnStartParamsForProfile(this.#context.profile, this.#context.cwd),
        ...runtimeTurnParams(this.#context.session.agentRuntimeConfig),
      })) as TurnStartResponse;
    } catch (error) {
      input.acceptance?.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
      if (this.#turnDone === currentTurnDone) {
        this.#turnDone = undefined;
      }
      throw error;
    }
    input.acceptance?.resolve();
    const activeTurnDone = this.#turnDone;
    if (activeTurnDone === currentTurnDone) {
      this.#activeTurnId = response.turn?.id ?? this.#activeTurnId;
      this.#filterTurnId = this.#activeTurnId ?? this.#filterTurnId;
      if (activeTurnDone.turnId === undefined) {
        activeTurnDone.turnId = this.#activeTurnId;
      }
      this.#sendPendingInterrupt();
    }
    await turnDone;
    if (this.#pendingTerminalStatus !== "stopped") {
      await this.#awaitPendingDirectiveApprovals();
    }
    this.#activeTurnId = undefined;
    this.#interruptRequested = false;
    this.#interruptSent = false;
    await this.#emitCompletedIfReady();
  }

  async #handleNotification(method: string, params: unknown): Promise<void> {
    if (method === "thread/started") {
      const threadId = threadIdFrom(params);
      if (threadId && this.#threadId === undefined) {
        this.#threadId = threadId;
        await this.#emit({ type: "thread", threadId });
      }
      return;
    }
    if (method === "turn/started") {
      this.#handleTurnStarted(params as TurnNotification);
      return;
    }
    if (method === "item/agentMessage/delta") {
      await this.#handleMessageDelta(params as AgentMessageDeltaNotification);
      return;
    }
    if (method === "item/started") {
      await this.#handleItemStarted(params as ItemStartedNotification);
      return;
    }
    if (method === "item/completed") {
      await this.#handleItemCompleted(params as ItemCompletedNotification);
      return;
    }
    if (method === "turn/completed") {
      await this.#handleTurnCompleted(params as TurnNotification);
      return;
    }
    if (method === "thread/status/changed") {
      await this.#handleThreadStatusChanged(
        params as ThreadStatusChangedNotification,
      );
      return;
    }
    if (method === "error") {
      const message =
        errorMessageFrom(params) ?? "Codex app-server reported an error";
      if (errorWillRetryFrom(params)) {
        await this.#emitActivity({ kind: "system", label: message });
        return;
      }
      this.#turnDone?.reject(new Error(message));
      this.#turnDone = undefined;
      await this.#emitError(message);
      return;
    }
    if (
      method === "command/exec/outputDelta" ||
      method === "item/commandExecution/outputDelta" ||
      method === "process/outputDelta"
    ) {
      return;
    }
    const activity = notificationActivityFor(method, params);
    if (activity && this.#isRootScopedOrGlobalNotification(params)) {
      await this.#emitActivity(activity);
    }
  }

  async #handleRequest(request: JsonRpcRequest): Promise<void> {
    if (this.#closed) {
      this.#client?.reject(
        request.id,
        `Codex app-server request received after session closed: ${request.method}`,
        -32000,
      );
      return;
    }
    if (request.method === "currentTime/read") {
      this.#handleCurrentTimeRead(request);
      return;
    }
    if (
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "execCommandApproval"
    ) {
      this.#deferRequest(request, () => this.#handleCommandApproval(request));
      return;
    }
    if (
      request.method === "item/fileChange/requestApproval" ||
      request.method === "applyPatchApproval"
    ) {
      this.#deferRequest(request, () => this.#handleFileApproval(request));
      return;
    }
    if (request.method === "item/permissions/requestApproval") {
      this.#deferRequest(request, () =>
        this.#handlePermissionApproval(request),
      );
      return;
    }
    if (
      request.method === "item/tool/requestUserInput" ||
      request.method === "tool/requestUserInput"
    ) {
      this.#deferRequest(request, () => this.#handleToolUserInput(request));
      return;
    }
    if (request.method === "mcpServer/elicitation/request") {
      this.#deferRequest(request, () => this.#handleMcpElicitation(request));
      return;
    }
    this.#client?.reject(
      request.id,
      `Unsupported Codex app-server request: ${request.method}`,
      -32601,
    );
  }

  #deferRequest(request: JsonRpcRequest, handle: () => Promise<void>): void {
    if (this.#closed) {
      this.#client?.reject(
        request.id,
        `Codex app-server request received after session closed: ${request.method}`,
        -32000,
      );
      return;
    }
    void handle().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.#client?.reject(request.id, message);
    });
  }

  #handleCurrentTimeRead(request: JsonRpcRequest): void {
    const unixTimestamp = Math.floor(Date.now() / 1000);
    this.#client?.respond(request.id, {
      currentTimeAt: unixTimestamp,
      currentTime: unixTimestamp,
      unixTimestamp,
      timestamp: unixTimestamp,
    });
  }

  async #steerTurn(input: AgentInput): Promise<void> {
    const threadId = this.#threadId;
    const turnId = this.#activeTurnId;
    if (!threadId || !turnId) {
      throw new Error("Cannot steer a Codex turn without an active turn");
    }
    await this.#request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: userInputFor({ content: input.content }),
    });
  }

  async #handleCommandApproval(request: JsonRpcRequest): Promise<void> {
    const params = request.params as CommandApprovalParams;
    const commandItem = this.#commandExecutionItems.get(params.itemId ?? "");
    const command = params.command ?? commandItem?.command;
    const cwd = params.cwd ?? commandItem?.cwd;
    const summary =
      params.reason ??
      (command ? `Run: ${command}` : "Codex wants to run a command");
    const decision = await this.#requestApproval({
      kind: "execCommand",
      summary,
      payload: {
        source: "codex-app-server",
        method: request.method,
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        approvalId: params.approvalId,
        command,
        cwd,
        commandActions: params.commandActions ?? commandItem?.commandActions,
        additionalPermissions:
          params.additionalPermissions ?? commandItem?.additionalPermissions,
        availableDecisions: params.availableDecisions,
        environmentId: params.environmentId ?? commandItem?.environmentId,
        networkApprovalContext:
          params.networkApprovalContext ?? commandItem?.networkApprovalContext,
        proposedExecpolicyAmendment:
          params.proposedExecpolicyAmendment ??
          commandItem?.proposedExecpolicyAmendment,
        proposedNetworkPolicyAmendments:
          params.proposedNetworkPolicyAmendments ??
          commandItem?.proposedNetworkPolicyAmendments,
        commandExecution: commandItem,
      },
    });
    this.#client?.respond(request.id, {
      decision: decision.approved
        ? commandApprovalAcceptDecision(request.method, params)
        : commandApprovalDeclineDecision(request.method),
    });
  }

  async #handleFileApproval(request: JsonRpcRequest): Promise<void> {
    const params = request.params as FileChangeApprovalParams;
    const decision = await this.#requestApproval({
      kind: "applyPatch",
      summary: params.reason ?? "Codex wants to apply file changes",
      payload: {
        source: "codex-app-server",
        method: request.method,
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        grantRoot: params.grantRoot,
        fileChange: this.#fileChangeItems.get(params.itemId ?? ""),
      },
    });
    this.#client?.respond(request.id, {
      decision: decision.approved
        ? fileApprovalAcceptDecision(request.method)
        : fileApprovalDeclineDecision(request.method),
    });
  }

  async #handlePermissionApproval(request: JsonRpcRequest): Promise<void> {
    const params = request.params as PermissionApprovalParams;
    const requestedPermissions = params.permissions ?? {};
    const decision = await this.#requestApproval({
      kind: "execCommand",
      summary: params.reason ?? "Codex wants additional permissions",
      payload: {
        source: "codex-app-server",
        method: request.method,
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        environmentId: params.environmentId,
        cwd: params.cwd,
        permissions: requestedPermissions,
      },
    });
    this.#client?.respond(request.id, {
      scope: "turn",
      permissions: decision.approved ? requestedPermissions : {},
    });
  }

  async #handleToolUserInput(request: JsonRpcRequest): Promise<void> {
    const params = request.params as ToolRequestUserInputParams;
    const draft = toolUserInputDraft(request.method, params);
    if (draft.questions.some((question) => question.isSecret)) {
      const message =
        "Codex requested secret user input, which RoamCli cannot collect safely yet";
      this.#client?.reject(request.id, message);
      await this.#fail(message, "CODEX_APP_SERVER_USER_INPUT_ERROR");
      return;
    }
    const decision = await this.#requestUserInput(draft);
    const answers: Record<string, { answers: string[] }> = {};
    draft.questions.forEach((question, index) => {
      answers[question.id] = {
        answers: index === 0 ? [decision.content] : [],
      };
    });
    this.#client?.respond(request.id, {
      answers,
    });
  }

  async #handleMcpElicitation(request: JsonRpcRequest): Promise<void> {
    const params = request.params as McpServerElicitationRequestParams;
    const decision = await this.#requestApproval({
      kind: "execCommand",
      summary: params.message ?? "Codex tool requested user input",
      payload: {
        source: "codex-app-server",
        method: request.method,
        threadId: params.threadId,
        turnId: params.turnId,
        serverName: params.serverName,
        mode: params.mode,
        url: params.url,
        elicitationId: params.elicitationId,
        requestedSchema: params.requestedSchema,
        meta: params._meta,
      },
    });
    this.#client?.respond(request.id, {
      action: mcpElicitationAction(params, decision),
      content: null,
      _meta: null,
    });
  }

  async #requestApproval(draft: ApprovalRequestDraft) {
    try {
      return await this.#context.requestApproval(draft);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#fail(message, "CODEX_APP_SERVER_APPROVAL_ERROR");
      throw error;
    }
  }

  async #requestUserInput(draft: UserInputRequestDraft) {
    try {
      if (this.#context.requestUserInput === undefined) {
        throw new Error("RoamCli does not support Codex tool user input");
      }
      return await this.#context.requestUserInput(draft);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.#fail(message, "CODEX_APP_SERVER_USER_INPUT_ERROR");
      throw error;
    }
  }

  async #handleMessageDelta(
    notification: AgentMessageDeltaNotification,
  ): Promise<void> {
    if (!notification.delta) {
      return;
    }
    const outputId = this.#outputId(notification.itemId);
    const previous = this.#streamedAssistantOutputs.get(outputId) ?? {
      rawText: "",
      emittedText: "",
    };
    const rawText = previous.rawText + notification.delta;
    const safeText = streamingDisplayText(rawText);
    const next = { rawText, emittedText: previous.emittedText };
    this.#streamedAssistantOutputs.set(outputId, next);
    if (safeText === previous.emittedText) {
      return;
    }
    const append = safeText.startsWith(previous.emittedText);
    const emitted = await this.#emit({
      type: "assistantOutput",
      outputId,
      content: append ? safeText.slice(previous.emittedText.length) : safeText,
      mode: append ? "append" : "replace",
      done: false,
    });
    if (emitted) {
      next.emittedText = safeText;
      this.#streamedOutputIds.add(outputId);
    }
  }

  async #handleItemStarted(
    notification: ItemStartedNotification,
  ): Promise<void> {
    const item = notification.item;
    if (!item?.id) {
      return;
    }
    if (item.type === "fileChange") {
      this.#fileChangeItems.set(item.id, item);
    }
    if (item.type === "commandExecution") {
      this.#commandExecutionItems.set(item.id, item);
    }
    if (!this.#isCurrentRootItemEvent(notification)) {
      return;
    }
    if (this.#activityStartedItems.has(item.id)) {
      return;
    }
    const activity = startedItemActivity(item);
    if (activity) {
      this.#activityStartedItems.add(item.id);
      await this.#emitActivity(activity);
    }
  }

  #appendStderrDiagnostic(chunk: string | Buffer): void {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    if (text.length === 0) {
      return;
    }
    this.#stderrDiagnostic = `${this.#stderrDiagnostic}${text}`;
    if (this.#stderrDiagnostic.length > MAX_STDERR_DIAGNOSTIC_LENGTH) {
      this.#stderrDiagnostic = this.#stderrDiagnostic.slice(
        -MAX_STDERR_DIAGNOSTIC_LENGTH,
      );
    }
  }

  #appServerExitMessage(
    code: number | null,
    signal: NodeJS.Signals | null,
    context?: string,
  ): string {
    const message = `Codex app-server exited${context ? ` ${context}` : ""}: code=${code ?? "null"} signal=${signal ?? "null"}`;
    const diagnostic = this.#stderrDiagnostic.trim();
    if (diagnostic.length === 0) {
      return message;
    }
    return `${message}\nstderr:\n${diagnostic}`;
  }

  async #handleItemCompleted(
    notification: ItemCompletedNotification,
  ): Promise<void> {
    const item = notification.item;
    if (this.#isCurrentRootItemEvent(notification)) {
      const activity = completedItemActivity(item);
      if (activity) {
        await this.#emitActivity(activity);
      }
    }
    if (item?.type !== "agentMessage" || !item.text) {
      return;
    }
    const outputId = this.#outputId(item.id);
    this.#streamedAssistantOutputs.delete(outputId);
    const directives = parseTextDirectives(item.text);
    if (
      directives.displayText.length > 0 ||
      this.#streamedOutputIds.has(outputId)
    ) {
      await this.#emit({
        type: "assistantOutput",
        outputId,
        content: directives.displayText,
        mode: "replace",
        done: true,
      });
    }
    await this.#emitTextDirectives(directives);
  }

  async #handleTurnCompleted(notification: TurnNotification): Promise<void> {
    if (!this.#isCurrentRootTurn(notification)) {
      return;
    }
    this.#filterTurnId =
      notification.turn?.id ??
      this.#turnDone?.turnId ??
      this.#activeTurnId ??
      this.#filterTurnId;
    const status = notification.turn?.status;
    const done = this.#turnDone;
    if (done && done.turnId === undefined) {
      done.turnId = notification.turn?.id;
    }
    this.#turnDone = undefined;
    this.#activeTurnId = undefined;
    if (status === "failed") {
      const message =
        notification.turn?.error?.message ?? "Codex app-server turn failed";
      done?.reject(new Error(message));
      await this.#emitError(message);
      return;
    }
    if (status === "interrupted") {
      this.#rejectQueuedInputs(new AgentInputUnavailableError());
      this.#pendingTerminalStatus = "stopped";
      done?.resolve();
      await this.#emitPendingTerminalStatus();
      return;
    }
    if (status !== "completed") {
      const message = `Codex app-server turn completed with unsupported status: ${status ?? "unknown"}`;
      done?.reject(new Error(message));
      await this.#emitError(message);
      return;
    }
    this.#turnCompletedSuccessfully = true;
    done?.resolve();
    await this.#emitCompletedIfReady();
  }

  #handleTurnStarted(notification: TurnNotification): void {
    if (this.#isKnownNonRootThread(notification)) {
      return;
    }
    const turnId = notification.turn?.id;
    if (!turnId) {
      return;
    }
    const expectedTurnId = this.#expectedRootTurnId();
    if (expectedTurnId !== undefined && expectedTurnId !== turnId) {
      return;
    }
    if (expectedTurnId === undefined && !this.#hasRootThreadId(notification)) {
      return;
    }
    this.#activeTurnId = turnId;
    this.#filterTurnId = turnId;
    if (this.#turnDone && this.#turnDone.turnId === undefined) {
      this.#turnDone.turnId = turnId;
    }
    this.#sendPendingInterrupt();
  }

  #isCurrentRootItemEvent(notification: unknown): boolean {
    const threadId = isRecord(notification)
      ? asString(notification.threadId)
      : undefined;
    const turnId = isRecord(notification)
      ? asString(notification.turnId)
      : undefined;
    if (
      threadId !== undefined &&
      this.#threadId !== undefined &&
      threadId !== this.#threadId
    ) {
      return false;
    }
    const expectedTurnId = this.#expectedRootTurnId();
    if (turnId !== undefined && expectedTurnId !== undefined) {
      return turnId === expectedTurnId;
    }
    if (turnId !== undefined) {
      return this.#isRootThreadId(threadId);
    }
    if (threadId !== undefined) {
      return this.#isRootThreadId(threadId);
    }
    return this.#turnDone !== undefined || expectedTurnId !== undefined;
  }

  #isRootThreadId(threadId: string | undefined): boolean {
    return (
      threadId !== undefined &&
      (this.#threadId === undefined || threadId === this.#threadId)
    );
  }

  #isRootScopedOrGlobalNotification(notification: unknown): boolean {
    const threadId = isRecord(notification)
      ? asString(notification.threadId)
      : undefined;
    const turnId = isRecord(notification)
      ? asString(notification.turnId)
      : undefined;
    if (threadId === undefined && turnId === undefined) {
      return true;
    }
    if (
      threadId !== undefined &&
      this.#threadId !== undefined &&
      threadId !== this.#threadId
    ) {
      return false;
    }
    const expectedTurnId = this.#expectedRootTurnId();
    if (turnId !== undefined && expectedTurnId !== undefined) {
      return turnId === expectedTurnId;
    }
    return this.#isRootThreadId(threadId);
  }

  #isCurrentRootTurn(notification: TurnNotification): boolean {
    if (this.#isKnownNonRootThread(notification)) {
      return false;
    }
    const turnId = notification.turn?.id;
    const expectedTurnId = this.#expectedRootTurnId();
    if (turnId !== undefined && expectedTurnId !== undefined) {
      return turnId === expectedTurnId;
    }
    if (turnId === undefined && expectedTurnId !== undefined) {
      return this.#hasRootThreadId(notification);
    }
    return this.#hasRootThreadId(notification);
  }

  #expectedRootTurnId(): string | undefined {
    return this.#turnDone?.turnId ?? this.#activeTurnId ?? this.#filterTurnId;
  }

  #isKnownNonRootThread(notification: { threadId?: string }): boolean {
    return (
      notification.threadId !== undefined &&
      this.#threadId !== undefined &&
      notification.threadId !== this.#threadId
    );
  }

  #hasRootThreadId(notification: { threadId?: string }): boolean {
    return (
      notification.threadId !== undefined &&
      (this.#threadId === undefined || notification.threadId === this.#threadId)
    );
  }

  async #handleThreadStatusChanged(
    notification: ThreadStatusChangedNotification,
  ): Promise<void> {
    if (
      notification.threadId !== undefined &&
      this.#threadId !== undefined &&
      notification.threadId !== this.#threadId
    ) {
      return;
    }
    const statusType = threadStatusTypeFrom(notification.status);
    if (statusType === "idle") {
      this.#rootThreadIdle = true;
      this.#resolveThreadIdleWaiters();
      await this.#emitCompletedIfReady();
      return;
    }
    this.#rootThreadIdle = false;
    if (statusType === "systemError") {
      await this.#fail(
        threadStatusMessageFrom(notification.status) ??
          "Codex app-server thread entered systemError",
      );
    }
  }

  async #awaitRootThreadIdleBeforeNextTurn(): Promise<void> {
    if (this.#turnSequence === 0 || this.#rootThreadIdle) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.#threadIdleWaiters.add(resolve);
    });
  }

  #resolveThreadIdleWaiters(): void {
    const waiters = [...this.#threadIdleWaiters];
    this.#threadIdleWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }

  async #emitCompletedIfReady(): Promise<boolean> {
    if (
      this.#closed ||
      !this.#turnCompletedSuccessfully ||
      !this.#rootThreadIdle ||
      this.#activeTurnId !== undefined ||
      this.#queue.length > 0 ||
      this.#pendingDirectiveApprovals.size > 0
    ) {
      return false;
    }
    this.#turnCompletedSuccessfully = false;
    this.#filterTurnId = undefined;
    this.#closeAppServer("SIGTERM");
    await this.#emit({ type: "status", status: "completed" });
    return true;
  }

  async #emitPendingTerminalStatus(): Promise<void> {
    const status = this.#pendingTerminalStatus;
    if (status === undefined) {
      return;
    }
    this.#pendingTerminalStatus = undefined;
    if (status === "stopped") {
      await this.#emitStopped();
    } else {
      await this.#emit({ type: "status", status });
    }
    this.#closeAppServer("SIGTERM");
  }

  async #emitStopped(): Promise<void> {
    if (this.#stoppedEmitted) {
      return;
    }
    this.#stoppedEmitted = true;
    await this.#emit({ type: "status", status: "stopped" });
  }

  async #request(method: string, params?: unknown): Promise<unknown> {
    try {
      return await this.#client?.request(method, params);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Codex app-server ${method} failed: ${message}`);
    }
  }

  async #emitTextDirectives(
    directives: ReturnType<typeof parseTextDirectives>,
  ): Promise<void> {
    for (const draft of directives.artifacts) {
      await this.#emit({ type: "artifact", draft });
    }
    for (const draft of directives.approvals) {
      this.#handleApprovalDirective(draft);
    }
  }

  #handleApprovalDirective(draft: ApprovalRequestDraft): void {
    const pending = this.#requestApproval(draft)
      .then(
        (decision) => {
          return this.#sendApprovalResponse(decision);
        },
        (error: unknown) => {
          if (this.#closed) {
            return;
          }
          const message =
            error instanceof Error ? error.message : String(error);
          void this.#fail(
            `Codex app-server approval directive failed: ${message}`,
          );
        },
      )
      .finally(() => {
        this.#pendingDirectiveApprovals.delete(pending);
      });
    this.#pendingDirectiveApprovals.add(pending);
  }

  async #sendApprovalResponse(decision: ApprovalDecision): Promise<void> {
    if (this.#closed || !this.#threadId) {
      return;
    }
    this.#queue.push({
      content: JSON.stringify({
        type: "approvalResponse",
        approvalId: decision.approvalId,
        approved: decision.approved,
        signedAt: decision.signedAt,
        ...(decision.signature === undefined
          ? {}
          : { signature: decision.signature }),
      }),
    });
    if (!this.#activeTurnId) {
      this.#startDrain();
    }
  }

  async #awaitPendingDirectiveApprovals(): Promise<void> {
    while (!this.#closed && this.#pendingDirectiveApprovals.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.#pendingDirectiveApprovals]),
        sleep(50),
      ]);
    }
  }

  async #fail(message: string, code = "CODEX_APP_SERVER_ERROR"): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#rejectQueuedInputs(new AgentInputUnavailableError(message));
    this.#pendingTerminalStatus = undefined;
    this.#resolveThreadIdleWaiters();
    this.#turnDone?.reject(new Error(message));
    this.#turnDone = undefined;
    this.#closeAppServer("SIGTERM");
    await this.#emitError(message, code);
    await this.#emit({ type: "status", status: "failed" });
  }

  async #emitError(
    message: string,
    code = "CODEX_APP_SERVER_ERROR",
  ): Promise<void> {
    await this.#emit({ type: "error", message, code });
  }

  async #emitActivity(activity: CodexActivitySummary): Promise<void> {
    await this.#emit({
      type: "activity",
      kind: activity.kind,
      label: compactActivityLabel(activity.label),
    });
  }

  async #emit(event: AgentRuntimeEvent): Promise<boolean> {
    try {
      await this.#context.emit(event);
      return true;
    } catch {
      return false;
    }
  }

  #outputId(itemId: string | undefined): string {
    return `${this.#outputPrefix}-${this.#turnSequence}:${
      itemId ?? this.#nextOutputId()
    }`;
  }

  #nextOutputId(): string {
    this.#outputSequence += 1;
    return `codex-output-${this.#outputSequence}`;
  }

  async #requestInterrupt(): Promise<void> {
    if (!this.#threadId || !this.#activeTurnId || this.#interruptSent) {
      return;
    }
    this.#interruptSent = true;
    await this.#client?.request("turn/interrupt", {
      threadId: this.#threadId,
      turnId: this.#activeTurnId,
    });
  }

  #sendPendingInterrupt(): void {
    if (!this.#interruptRequested) {
      return;
    }
    void this.#requestInterrupt().catch(() => undefined);
  }

  #closeAppServer(signal: NodeJS.Signals): void {
    this.#closed = true;
    this.#rejectQueuedInputs(new AgentInputUnavailableError());
    this.#resolveThreadIdleWaiters();
    this.#client?.close();
    this.#child?.kill(signal);
  }

  #rejectQueuedInputs(error: Error): void {
    for (const input of this.#queue.splice(0)) {
      input.acceptance?.reject(error);
    }
  }
}

function createInputAcceptance(): InputAcceptance {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function userInputFor(input: QueuedInput): UserInput[] {
  return [
    {
      type: "text",
      text: input.content,
      text_elements: [],
    },
    ...(input.attachments ?? []).flatMap((attachment): UserInput[] =>
      attachment.kind === "image"
        ? [{ type: "localImage", path: attachment.localPath, detail: "auto" }]
        : [],
    ),
  ];
}

function threadStartParamsForProfile(profile: RunnerProfile): {
  approvalPolicy: AskForApproval;
  permissions?: never;
} {
  if (profile === "trusted") {
    return {
      approvalPolicy: "never",
    };
  }
  return {
    approvalPolicy: "on-request",
  };
}

function turnStartParamsForProfile(
  profile: RunnerProfile,
  cwd: string,
): {
  approvalPolicy: AskForApproval;
  sandboxPolicy: SandboxPolicy;
  permissions?: never;
} {
  if (profile === "trusted") {
    return {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    };
  }
  if (profile === "strict") {
    return {
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    };
  }
  return {
    approvalPolicy: "on-request",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [cwd],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  };
}

function runtimeThreadParams(
  config: AgentSessionContext["session"]["agentRuntimeConfig"],
): { model?: string; serviceTier?: string } {
  if (!config) {
    return {};
  }
  return {
    ...(config.model ? { model: config.model } : {}),
    ...(config.serviceTier ? { serviceTier: config.serviceTier } : {}),
  };
}

function runtimeTurnParams(
  config: AgentSessionContext["session"]["agentRuntimeConfig"],
): { model?: string; serviceTier?: string; effort?: string } {
  if (!config) {
    return {};
  }
  return {
    ...(config.model ? { model: config.model } : {}),
    ...(config.serviceTier ? { serviceTier: config.serviceTier } : {}),
    ...(config.reasoningEffort ? { effort: config.reasoningEffort } : {}),
  };
}

function notificationActivityFor(
  method: string,
  params: unknown,
): CodexActivitySummary | undefined {
  if (
    method === "warning" ||
    method === "configWarning" ||
    method === "guardianWarning"
  ) {
    return {
      kind: "system",
      label: `Codex warning: ${warningMessageFrom(params) ?? "Check Codex configuration"}`,
    };
  }
  if (method === "model/rerouted") {
    const toModel = isRecord(params) ? asString(params.toModel) : undefined;
    return {
      kind: "system",
      label: toModel ? `Model rerouted to ${toModel}` : "Model rerouted",
    };
  }
  return undefined;
}

function startedItemActivity(item: unknown): CodexActivitySummary | undefined {
  if (!isRecord(item)) {
    return undefined;
  }
  switch (item.type) {
    case "commandExecution":
      return {
        kind: "tool",
        label: `${commandStartVerb(item)} ${commandActivityObject(item)}`,
      };
    case "fileChange":
      return {
        kind: "tool",
        label: fileChangeActivityLabel("Proposed edits to", item),
      };
    case "mcpToolCall":
    case "dynamicToolCall":
      return { kind: "tool", label: `Using ${toolActivityObject(item)}` };
    case "webSearch":
      return { kind: "tool", label: "Searching web" };
    case "imageGeneration":
      return { kind: "tool", label: "Generating image" };
    case "imageView":
      return { kind: "tool", label: "Viewing image" };
    case "contextCompaction":
      return { kind: "status", label: "Compacting context" };
    case "collabToolCall":
    case "collabAgentToolCall":
      return { kind: "status", label: collabActivityLabel(item) };
    default:
      return undefined;
  }
}

function completedItemActivity(
  item: unknown,
): CodexActivitySummary | undefined {
  if (!isRecord(item) || !itemNeedsAttention(item)) {
    return undefined;
  }
  const attention = attentionStatus(item);
  switch (item.type) {
    case "commandExecution":
      return {
        kind: "tool",
        label: `Command ${attention}: ${commandActivityObject(item)}`,
      };
    case "fileChange":
      return {
        kind: "tool",
        label: fileChangeActivityLabel(`File edit ${attention}`, item),
      };
    case "mcpToolCall":
    case "dynamicToolCall":
      return {
        kind: "tool",
        label: `Tool ${attention}: ${toolActivityObject(item)}`,
      };
    case "webSearch":
      return { kind: "tool", label: `Web search ${attention}` };
    case "imageGeneration":
      return { kind: "tool", label: `Image generation ${attention}` };
    case "imageView":
      return { kind: "tool", label: `Image view ${attention}` };
    case "contextCompaction":
      return { kind: "status", label: `Context compaction ${attention}` };
    case "collabToolCall":
    case "collabAgentToolCall":
      return { kind: "status", label: `Agent coordination ${attention}` };
    default:
      return undefined;
  }
}

function commandStartVerb(item: Record<string, unknown>): string {
  const status = asString(item.status);
  return status === "running" ? "Running" : "Command";
}

function itemNeedsAttention(item: Record<string, unknown>): boolean {
  const status = asString(item.status);
  return (
    status === "failed" ||
    status === "declined" ||
    status === "error" ||
    status === "cancelled" ||
    status === "canceled" ||
    item.success === false ||
    (item.error !== undefined && item.error !== null)
  );
}

function attentionStatus(item: Record<string, unknown>): string {
  const status = asString(item.status);
  if (status === "declined") {
    return "declined";
  }
  if (status === "cancelled" || status === "canceled") {
    return "cancelled";
  }
  return "failed";
}

function commandActivityObject(item: Record<string, unknown>): string {
  return compactActivityObject(asString(item.command) ?? "command");
}

function fileChangeActivityLabel(
  prefix: string,
  item: Record<string, unknown>,
): string {
  const count = Array.isArray(item.changes) ? item.changes.length : 0;
  if (count <= 0) {
    return `${prefix} files`;
  }
  return `${prefix} ${count} ${count === 1 ? "file" : "files"}`;
}

function toolActivityObject(item: Record<string, unknown>): string {
  const server = asString(item.server);
  const namespace = asString(item.namespace);
  const tool = asString(item.tool);
  const parts = [server ?? namespace, tool].filter((part): part is string =>
    Boolean(part),
  );
  return compactActivityObject(parts.join(" ") || "tool");
}

function collabActivityLabel(item: Record<string, unknown>): string {
  const tool = asString(item.tool);
  if (tool === "wait") {
    return "Waiting for agent";
  }
  if (tool === "spawn" || tool === "spawn_agent") {
    return "Starting agent";
  }
  return "Coordinating agents";
}

function warningMessageFrom(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const message = asString(value.message);
  if (message) {
    return message;
  }
  const summary = asString(value.summary);
  if (summary) {
    return summary;
  }
  if (isRecord(value.error)) {
    return asString(value.error.message);
  }
  return undefined;
}

function compactActivityObject(value: string): string {
  return compactActivityLabel(value, MAX_ACTIVITY_OBJECT_LENGTH);
}

function compactActivityLabel(
  value: string,
  maxLength = MAX_ACTIVITY_LABEL_LENGTH,
): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length === 0) {
    return "Codex activity";
  }
  if (compacted.length <= maxLength) {
    return compacted;
  }
  return `${compacted.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function threadIdFrom(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.thread)) {
    return undefined;
  }
  return asString(value.thread.id);
}

function errorMessageFrom(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.error)) {
    return undefined;
  }
  return asString(value.error.message);
}

function errorWillRetryFrom(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.willRetry === "boolean") {
    return value.willRetry;
  }
  return isRecord(value.error) && value.error.willRetry === true;
}

function threadStatusTypeFrom(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  return asString(value.type);
}

function threadStatusMessageFrom(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.message === "string" && value.message.length > 0) {
    return value.message;
  }
  if (isRecord(value.error)) {
    return asString(value.error.message);
  }
  return undefined;
}

function toolUserInputSummary(params: ToolRequestUserInputParams): string {
  const question = params.questions?.find(
    (candidate) => typeof candidate.question === "string",
  )?.question;
  return question ?? "Codex tool requested user input";
}

function toolUserInputDraft(
  method: string,
  params: ToolRequestUserInputParams,
): UserInputRequestDraft {
  const questions = normalizeToolUserInputQuestions(params);
  return {
    summary: toolUserInputSummary(params),
    questions,
    payload: {
      source: "codex-app-server",
      method,
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      questions: params.questions,
    },
  };
}

function normalizeToolUserInputQuestions(
  params: ToolRequestUserInputParams,
): UserInputQuestion[] {
  const questions = params.questions ?? [];
  return questions.map((question, index) => {
    const id =
      typeof question.id === "string" && question.id.length > 0
        ? question.id
        : `question-${index + 1}`;
    return {
      id,
      header: typeof question.header === "string" ? question.header : "",
      question:
        typeof question.question === "string" && question.question.length > 0
          ? question.question
          : "Codex requested user input",
      isOther: question.isOther === true,
      isSecret: question.isSecret === true,
      options: normalizeToolUserInputOptions(question.options),
    };
  });
}

function normalizeToolUserInputOptions(
  options: ToolRequestUserInputOption[] | null | undefined,
): readonly UserInputQuestionOption[] | null {
  if (!Array.isArray(options)) {
    return null;
  }
  return options.map((option) => ({
    label: typeof option.label === "string" ? option.label : "",
    description:
      typeof option.description === "string" ? option.description : "",
  }));
}

function commandApprovalAcceptDecision(
  method: string,
  params: CommandApprovalParams,
): unknown {
  if (method === "execCommandApproval") {
    return "approved";
  }
  const decisions = Array.isArray(params.availableDecisions)
    ? params.availableDecisions
    : [];
  const amendmentDecision = decisions.find(isCommandPolicyAmendmentDecision);
  if (amendmentDecision) {
    return amendmentDecision;
  }
  if (decisions.includes("accept")) {
    return "accept";
  }
  return decisions[0] ?? "accept";
}

function commandApprovalDeclineDecision(method: string): string {
  return method === "execCommandApproval" ? "denied" : "decline";
}

function fileApprovalAcceptDecision(method: string): string {
  return method === "applyPatchApproval" ? "approved" : "accept";
}

function fileApprovalDeclineDecision(method: string): string {
  return method === "applyPatchApproval" ? "denied" : "decline";
}

function isCommandPolicyAmendmentDecision(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return (
    "acceptWithExecpolicyAmendment" in value ||
    "applyNetworkPolicyAmendment" in value
  );
}

function mcpElicitationAction(
  _params: McpServerElicitationRequestParams,
  decision: ApprovalDecision,
): "accept" | "decline" | "cancel" {
  if (!decision.approved) {
    return "decline";
  }
  return "cancel";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
