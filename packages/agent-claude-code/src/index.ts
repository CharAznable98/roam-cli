import { readFile } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  Options,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import type {
  AgentDefinition,
  AgentInput,
  AgentPlugin,
  AgentPluginContext,
  AgentSession,
  AgentSessionContext,
} from "@roamcli/agent-plugin-sdk";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGES_PER_TURN,
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
  #abortController?: AbortController;
  #query?: ReturnType<typeof query>;
  #closed = false;
  #sawAssistantMessage = false;

  public constructor(context: AgentSessionContext) {
    this.#context = context;
  }

  public async start(): Promise<void> {
    this.#abortController = new AbortController();
    void this.#run().catch((error: unknown) => {
      void this.#context.emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
        code: "CLAUDE_CODE_ERROR",
      });
      void this.#context.emit({ type: "status", status: "failed" });
    });
  }

  public deliverInput(_input: AgentInput): void {
    // RoamCli starts one Claude SDK query per user turn. Running-turn input is
    // intentionally ignored until a future prompt type needs it.
  }

  public async control(signal: "interrupt" | "stop" | "resume"): Promise<void> {
    if (signal === "interrupt") {
      await this.#query?.interrupt();
      return;
    }
    if (signal === "stop") {
      this.#closed = true;
      this.#abortController?.abort();
      this.#query?.close();
      await this.#context.emit({ type: "status", status: "stopped" });
      return;
    }
  }

  public close(): void {
    this.#closed = true;
    this.#abortController?.abort();
    this.#query?.close();
  }

  async #run(): Promise<void> {
    const sdkQuery = query({
      prompt: promptForContext(this.#context),
      options: this.#options(),
    });
    this.#query = sdkQuery;

    for await (const message of sdkQuery) {
      await this.#handleMessage(message);
    }
    if (!this.#closed) {
      await this.#context.emit({ type: "status", status: "completed" });
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
    if (this.#context.resumeThreadId) {
      options.resume = this.#context.resumeThreadId;
    }
    return options;
  }

  async #handleMessage(message: SDKMessage): Promise<void> {
    const sessionId = sdkSessionId(message);
    if (sessionId) {
      await this.#context.emit({ type: "thread", threadId: sessionId });
    }
    if (message.type === "stream_event") {
      const text = partialText(message.event);
      if (text.length > 0) {
        await this.#context.emit({ type: "token", content: text });
      }
      return;
    }
    if (message.type === "assistant") {
      const text = textFromContent(message.message.content);
      if (text.length > 0) {
        this.#sawAssistantMessage = true;
        await this.#context.emit({ type: "message", content: text });
      }
      if (message.error) {
        await this.#context.emit({
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
        !this.#sawAssistantMessage &&
        message.result.length > 0
      ) {
        await this.#context.emit({ type: "message", content: message.result });
      }
      if (message.subtype !== "success") {
        await this.#context.emit({
          type: "error",
          message: message.errors.join("\n") || message.subtype,
          code: "CLAUDE_CODE_RESULT_ERROR",
        });
        await this.#context.emit({ type: "status", status: "failed" });
        this.#closed = true;
      }
      return;
    }
    if (message.type === "system" && message.subtype !== "init") {
      const summary = summarizeSystemMessage(message);
      if (summary) {
        await this.#context.emit({ type: "message", content: summary });
      }
    }
  }
}

function promptForContext(
  context: AgentSessionContext,
): string | AsyncIterable<SDKUserMessage> {
  if (!context.attachments?.length) {
    return context.prompt;
  }
  return userMessages(context);
}

async function* userMessages(
  context: AgentSessionContext,
): AsyncIterable<SDKUserMessage> {
  yield await userMessage(context);
}

async function userMessage(context: AgentSessionContext): Promise<SDKUserMessage> {
  const content: MessageParam["content"] = context.attachments?.length
    ? await messageContentWithImages(context)
    : context.prompt;
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
  context: AgentSessionContext,
): Promise<ContentBlockParam[]> {
  const imageBlocks = await Promise.all(
    (context.attachments ?? []).map(async (attachment) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: supportedImageMimeType(attachment.mimeType),
        data: await readFile(attachment.localPath, "base64"),
      },
    })),
  );
  return [{ type: "text", text: context.prompt }, ...imageBlocks];
}

async function listClaudeCodeSkills(context: {
  profile: RunnerProfile;
  env: NodeJS.ProcessEnv;
  basePath: string;
}): Promise<AgentSkillSummary[]> {
  try {
    const sdkQuery = query({
      prompt: " ",
      options: {
        cwd: context.basePath,
        env: { ...context.env },
        permissionMode: "plan",
        includePartialMessages: false,
        maxTurns: 1,
      },
    });
    try {
      const commands = await sdkQuery.supportedCommands();
      return commands.map((command) => ({
        name: command.name,
        description: command.description,
        sourceType: "project",
        sourcePath: context.basePath,
      }));
    } finally {
      sdkQuery.close();
    }
  } catch {
    return [];
  }
}

function supportedImageMimeType(mimeType: string): SupportedImageMimeType {
  if (
    SUPPORTED_IMAGE_MIME_TYPES.includes(mimeType as SupportedImageMimeType)
  ) {
    return mimeType as SupportedImageMimeType;
  }
  throw new Error(`Unsupported Claude Code image mime type: ${mimeType}`);
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

function summarizeSystemMessage(message: SDKMessage): string | undefined {
  if (message.type !== "system") {
    return undefined;
  }
  if (message.subtype === "status" && message.status) {
    return `Claude Code status: ${message.status}`;
  }
  if (message.subtype === "task_started") {
    return `Claude Code task started: ${message.description}`;
  }
  if (message.subtype === "task_progress") {
    return `Claude Code task progress: ${message.description}`;
  }
  if (message.subtype === "task_notification") {
    return `Claude Code task ${message.status}: ${message.summary}`;
  }
  return undefined;
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
