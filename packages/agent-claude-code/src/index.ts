import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ContentBlockParam,
  MessageParam,
} from "@anthropic-ai/sdk/resources";
import type {
  AgentDefinition,
  AgentInput,
  AgentLaunchAttachment,
  AgentPlugin,
  AgentPluginContext,
  AgentRuntimeEvent,
  AgentSession,
  AgentSessionContext,
  AgentSkillListContext,
} from "@roamcli/agent-plugin-sdk";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGES_PER_TURN,
  type AgentActivityKind,
  type AgentSkillSummary,
  type RunnerCapability,
  type RunnerProfile,
} from "@roamcli/shared/protocol";

const KIND = "claude-code";
const LABEL = "Claude Code";
const PLUGIN_NAME = "@roamcli/agent-claude-code";
const PLUGIN_VERSION = "1.1.0";
const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

export const claudeCodeAgent: AgentDefinition = {
  kind: KIND,
  label: LABEL,
  buildCapability(context: AgentPluginContext): RunnerCapability {
    return {
      kind: KIND,
      label: LABEL,
      command:
        context.env.ROAMCLI_AGENT_CLAUDE_CODE_COMMAND?.trim() || "claude",
      args: [],
      parser: "claude-agent-sdk",
      supportsResume: true,
      supportsImages: true,
      supportedImageMimeTypes: [...SUPPORTED_IMAGE_MIME_TYPES],
      maxImagesPerTurn: DEFAULT_MAX_IMAGES_PER_TURN,
      maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
      pluginName: PLUGIN_NAME,
      pluginVersion: PLUGIN_VERSION,
    };
  },
  createSession(context: AgentSessionContext): AgentSession {
    return new ClaudeCodeSession(context);
  },
  async listSkills(context) {
    return listClaudeCodeSkills(context);
  },
};

export const agentPlugin: AgentPlugin = {
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  agents() {
    return [claudeCodeAgent];
  },
};

export default agentPlugin;

class ClaudeCodeSession implements AgentSession {
  readonly #context: AgentSessionContext;
  readonly #queue: ClaudeCodeInput[] = [];
  #abortController: AbortController | undefined;
  #query: ReturnType<typeof query> | undefined;
  #closed = false;
  #draining = false;
  #resumeThreadId: string | undefined;
  #sawAssistantOutput = false;
  #sawStreamText = false;
  #needsFinalOutputFallback = false;

  public constructor(context: AgentSessionContext) {
    this.#context = context;
    this.#resumeThreadId = context.resumeThreadId;
  }

  public async start(): Promise<void> {
    this.#queue.push({
      content: this.#context.prompt,
      ...(this.#context.attachments
        ? { attachments: this.#context.attachments }
        : {}),
    });
    this.#startDrain();
  }

  public deliverInput(input: AgentInput): void {
    if (this.#closed) {
      return;
    }
    this.#queue.push({ content: input.content });
    this.#startDrain();
  }

  public async control(signal: "interrupt" | "stop" | "resume"): Promise<void> {
    if (signal === "interrupt") {
      await this.#query?.interrupt();
      return;
    }
    if (signal === "stop") {
      this.#closed = true;
      this.#queue.length = 0;
      this.#abortController?.abort();
      this.#query?.close();
      await this.#emit({ type: "status", status: "stopped" });
      return;
    }
  }

  public close(): void {
    this.#closed = true;
    this.#queue.length = 0;
    this.#abortController?.abort();
    this.#query?.close();
  }

  #startDrain(): void {
    if (this.#draining) {
      return;
    }
    this.#draining = true;
    void this.#drain()
      .catch((error: unknown) => {
        if (this.#closed) {
          return;
        }
        this.#closed = true;
        this.#queue.length = 0;
        void this.#emit({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
          code: "CLAUDE_CODE_ERROR",
        });
        void this.#emit({ type: "status", status: "failed" });
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
      const input = this.#queue.shift();
      if (input === undefined) {
        await this.#emit({ type: "status", status: "completed" });
        return;
      }
      await this.#run(input);
    }
  }

  async #run(input: ClaudeCodeInput): Promise<void> {
    this.#abortController = new AbortController();
    this.#sawAssistantOutput = false;
    this.#sawStreamText = false;
    this.#needsFinalOutputFallback = false;
    const sdkQuery = query({
      prompt: promptForInput(input),
      options: this.#options(),
    });
    this.#query = sdkQuery;

    for await (const message of sdkQuery) {
      await this.#handleMessage(message);
    }
    if (!this.#closed) {
      this.#query = undefined;
      this.#abortController = undefined;
    }
  }

  #options(): Options {
    const model = this.#context.env.ROAMCLI_AGENT_CLAUDE_CODE_MODEL?.trim();
    const maxTurns = parsePositiveInteger(
      this.#context.env.ROAMCLI_AGENT_CLAUDE_CODE_MAX_TURNS,
    );
    const pathToClaudeCodeExecutable =
      this.#context.env.ROAMCLI_AGENT_CLAUDE_CODE_COMMAND?.trim();
    const options: Options = {
      cwd: this.#context.cwd,
      env: { ...this.#context.env },
      includePartialMessages: true,
      permissionMode: permissionModeFor(this.#context.profile),
      canUseTool: async (toolName, input, permission) => {
        if (this.#context.profile === "trusted") {
          return { behavior: "allow" };
        }
        const decision = await this.#context.requestApproval({
          kind: "execCommand",
          summary:
            permission.title ??
            permission.displayName ??
            `Claude Code wants to use ${toolName}`,
          payload: {
            toolName,
            input,
            displayName: permission.displayName,
            description: permission.description,
            decisionReason: permission.decisionReason,
            blockedPath: permission.blockedPath,
            toolUseId: permission.toolUseID,
          },
        });
        if (decision.approved) {
          return { behavior: "allow" } satisfies PermissionResult;
        }
        return {
          behavior: "deny",
          message: "Denied by RoamCli approval",
        } satisfies PermissionResult;
      },
    };
    if (this.#context.profile === "trusted") {
      options.allowDangerouslySkipPermissions = true;
    }
    if (this.#abortController !== undefined) {
      options.abortController = this.#abortController;
    }
    if (model) {
      options.model = model;
    }
    if (maxTurns !== undefined) {
      options.maxTurns = maxTurns;
    }
    if (pathToClaudeCodeExecutable) {
      options.pathToClaudeCodeExecutable = pathToClaudeCodeExecutable;
    }
    if (this.#resumeThreadId) {
      options.resume = this.#resumeThreadId;
    }
    return options;
  }

  async #handleMessage(message: SDKMessage): Promise<void> {
    const sessionId = sdkSessionId(message);
    if (sessionId) {
      if (await this.#emit({ type: "thread", threadId: sessionId })) {
        this.#resumeThreadId = sessionId;
      }
    }
    if (message.type === "stream_event") {
      const text = partialText(message.event);
      if (text.length > 0) {
        if (await this.#emit({ type: "token", content: text })) {
          this.#sawAssistantOutput = true;
          this.#sawStreamText = true;
        } else {
          this.#needsFinalOutputFallback = true;
        }
      }
      return;
    }
    if (message.type === "assistant") {
      const text = textFromContent(message.message.content);
      if (text.length > 0) {
        if (!this.#sawStreamText || this.#needsFinalOutputFallback) {
          if (await this.#emit({ type: "message", content: text })) {
            this.#sawAssistantOutput = true;
            this.#needsFinalOutputFallback = false;
          }
        }
      }
      if (message.error) {
        await this.#emit({
          type: "error",
          message: message.error,
          code: "CLAUDE_CODE_ASSISTANT_ERROR",
        });
      }
      return;
    }
    if (message.type === "result") {
      if (
        message.subtype === "success" &&
        (!this.#sawAssistantOutput || this.#needsFinalOutputFallback) &&
        message.result.length > 0
      ) {
        if (await this.#emit({ type: "message", content: message.result })) {
          this.#sawAssistantOutput = true;
          this.#needsFinalOutputFallback = false;
        }
      }
      if (message.subtype !== "success") {
        await this.#emit({
          type: "error",
          message: message.errors.join("\n") || message.subtype,
          code: "CLAUDE_CODE_RESULT_ERROR",
        });
        await this.#emit({ type: "status", status: "failed" });
        this.#closed = true;
      }
      return;
    }
    if (message.type === "system" && message.subtype !== "init") {
      const activity = summarizeSystemActivity(message);
      if (activity) {
        await this.#emit({ type: "activity", ...activity });
      }
    }
  }

  async #emit(event: AgentRuntimeEvent): Promise<boolean> {
    try {
      await this.#context.emit(event);
      return true;
    } catch {
      // Event delivery belongs to the runner sink and must not change Claude's
      // session result.
      return false;
    }
  }
}

interface ClaudeCodeInput {
  content: string;
  attachments?: readonly AgentLaunchAttachment[];
}

function promptForInput(
  input: ClaudeCodeInput,
): string | AsyncIterable<SDKUserMessage> {
  if (!input.attachments?.length) {
    return input.content;
  }
  return userMessages(input);
}

async function* userMessages(
  input: ClaudeCodeInput,
): AsyncIterable<SDKUserMessage> {
  yield await userMessage(input);
}

async function userMessage(input: ClaudeCodeInput): Promise<SDKUserMessage> {
  const content: MessageParam["content"] = input.attachments?.length
    ? await messageContentWithImages(input)
    : input.content;
  return {
    type: "user",
    message: {
      role: "user",
      content,
    },
    parent_tool_use_id: null,
  };
}

async function messageContentWithImages(
  input: ClaudeCodeInput,
): Promise<ContentBlockParam[]> {
  const imageBlocks = await Promise.all(
    (input.attachments ?? []).map(async (attachment) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: supportedImageMimeType(attachment.mimeType),
        data: await readFile(attachment.localPath, "base64"),
      },
    })),
  );
  return [{ type: "text", text: input.content }, ...imageBlocks];
}

async function listClaudeCodeSkills(
  context: AgentSkillListContext,
): Promise<AgentSkillSummary[]> {
  try {
    const basePath = await resolveSkillBase(
      context.workspace,
      context.basePath,
    );
    if (basePath === undefined) {
      return [];
    }
    const command = context.env.ROAMCLI_AGENT_CLAUDE_CODE_COMMAND?.trim();
    const options: Options = {
      cwd: basePath,
      env: { ...context.env },
      permissionMode: "plan",
      includePartialMessages: false,
      maxTurns: 1,
    };
    if (command) {
      options.pathToClaudeCodeExecutable = command;
    }
    const sdkQuery = query({
      prompt: " ",
      options,
    });
    try {
      const commands = await sdkQuery.supportedCommands();
      return commands.flatMap((command) => {
        const name = claudeCommandName(command.name);
        if (!name) {
          return [];
        }
        return [
          {
            name,
            description: command.description,
            insertText: `/${name}`,
            sourceType: "project",
            sourcePath: basePath,
          },
        ];
      });
    } finally {
      sdkQuery.close();
    }
  } catch {
    return [];
  }
}

function claudeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "");
}

function supportedImageMimeType(mimeType: string): SupportedImageMimeType {
  if (SUPPORTED_IMAGE_MIME_TYPES.includes(mimeType as SupportedImageMimeType)) {
    return mimeType as SupportedImageMimeType;
  }
  throw new Error(`Unsupported Claude Code image mime type: ${mimeType}`);
}

async function resolveSkillBase(
  workspace: string,
  basePath: string,
): Promise<string | undefined> {
  try {
    const workspacePath = resolve(workspace);
    const candidate = isAbsolute(basePath)
      ? resolve(basePath)
      : resolve(workspacePath, basePath);
    const [realWorkspace, realCandidate] = await Promise.all([
      realpath(workspacePath),
      realpath(candidate),
    ]);
    const candidateStat = await stat(realCandidate);
    if (
      !candidateStat.isDirectory() ||
      !isInside(realWorkspace, realCandidate)
    ) {
      return undefined;
    }
    return realCandidate;
  } catch {
    return undefined;
  }
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function permissionModeFor(
  profile: RunnerProfile,
): NonNullable<Options["permissionMode"]> {
  if (profile === "trusted") {
    return "bypassPermissions";
  }
  return "default";
}

function sdkSessionId(message: SDKMessage): string | undefined {
  return "session_id" in message && typeof message.session_id === "string"
    ? message.session_id
    : undefined;
}

function partialText(event: unknown): string {
  if (!isRecord(event) || event.type !== "content_block_delta") {
    return "";
  }
  const delta = event.delta;
  if (!isRecord(delta) || delta.type !== "text_delta") {
    return "";
  }
  return typeof delta.text === "string" ? delta.text : "";
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
}

function summarizeSystemActivity(
  message: SDKMessage,
): { kind: AgentActivityKind; label: string } | undefined {
  if (message.type !== "system") {
    return undefined;
  }
  if (message.subtype === "status" && message.status) {
    return { kind: "status", label: statusActivityLabel(message.status) };
  }
  if (message.subtype === "task_started") {
    return {
      kind: "task_started",
      label: productizeActivityLabel(message.description),
    };
  }
  if (message.subtype === "task_progress") {
    return {
      kind: "task_progress",
      label: productizeActivityLabel(message.description),
    };
  }
  if (message.subtype === "task_notification") {
    return {
      kind: "task_notification",
      label: productizeActivityLabel(
        message.summary || `Task ${message.status}`,
      ),
    };
  }
  return undefined;
}

function statusActivityLabel(status: string): string {
  const cleanStatus = status.trim();
  if (cleanStatus === "requesting") {
    return "Requesting";
  }
  return productizeActivityLabel(cleanStatus);
}

function productizeActivityLabel(value: string): string {
  const label = value.trim().replace(/\s+/g, " ");
  if (!label) {
    return "Working";
  }
  const rules: Array<[RegExp, string]> = [
    [/^Explore\s+(.+)$/i, "Exploring $1"],
    [/^Read\s+(.+)$/i, "Reading $1"],
    [/^List\s+(.+)$/i, "Listing $1"],
    [/^Search\s+(.+)$/i, "Searching $1"],
    [/^Run\s+(.+)$/i, "Running $1"],
    [/^Write\s+(.+)$/i, "Writing $1"],
    [/^Edit\s+(.+)$/i, "Editing $1"],
    [/^Check\s+(.+)$/i, "Checking $1"],
  ];
  const withoutRunningPrefix = label.replace(/^Running\s+(.+)$/i, "$1");
  for (const [pattern, replacement] of rules) {
    if (pattern.test(withoutRunningPrefix)) {
      return withoutRunningPrefix.replace(pattern, replacement);
    }
  }
  return (
    withoutRunningPrefix.charAt(0).toUpperCase() + withoutRunningPrefix.slice(1)
  );
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
