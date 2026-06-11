import type {
  AgentDefinition,
  AgentLaunch,
  AgentLaunchContext,
  AgentOutputParser,
  AgentParseResult,
  AgentPlugin,
  AgentPluginContext,
  ApprovalRequestDraft,
  ArtifactDraft,
} from "@roamcli/agent-plugin-sdk";
import type { RunnerCapability } from "@roamcli/protocol";

const KIND = "codex";
const PLUGIN_NAME = "@roamcli/agent-codex";
const PLUGIN_VERSION = "1.1.0";
const DEFAULT_ARGS = [
  "exec",
  "--json",
  "--color",
  "never",
  "--skip-git-repo-check",
  "--dangerously-bypass-approvals-and-sandbox",
];

export const codexAgent: AgentDefinition = {
  kind: KIND,
  label: "Codex",
  buildCapability(context: AgentPluginContext): RunnerCapability {
    return {
      kind: KIND,
      label: "Codex",
      command: commandFor(KIND, context.env),
      args: argsFor(KIND, context.env),
      parser: "codex-json",
      supportsResume: true,
      pluginName: PLUGIN_NAME,
      pluginVersion: PLUGIN_VERSION,
    };
  },
  buildLaunch(context: AgentLaunchContext): AgentLaunch {
    const baseArgs = argsFor(KIND, context.env);
    return {
      command: commandFor(KIND, context.env),
      args: codexJsonArgs(baseArgs, context.prompt, context.resumeThreadId),
      preferPty: false,
      requirePty: false,
      promptDelivery: "argument",
    };
  },
  createParser(): AgentOutputParser {
    return new CodexJsonParser();
  },
};

export const agentPlugin: AgentPlugin = {
  name: PLUGIN_NAME,
  version: PLUGIN_VERSION,
  agents() {
    return [codexAgent];
  },
};

export default agentPlugin;

export class CodexJsonParser implements AgentOutputParser {
  #buffer = "";

  feed(chunk: string | Buffer): AgentParseResult {
    this.#buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    const messages: string[] = [];
    let threadId: string | undefined;
    const approvals: ApprovalRequestDraft[] = [];
    const artifacts: ArtifactDraft[] = [];
    const lines = this.#completeLines();
    for (const line of lines) {
      const event = parseJsonObject(line);
      if (event?.type === "thread.started" && typeof event.thread_id === "string") {
        threadId = event.thread_id;
        continue;
      }
      if (event?.type !== "item.completed" || !isRecord(event.item)) {
        continue;
      }
      if (event.item.type !== "agent_message" || typeof event.item.text !== "string") {
        continue;
      }
      const directives = parseTextDirectives(event.item.text);
      approvals.push(...directives.approvals);
      artifacts.push(...directives.artifacts);
      messages.push(event.item.text);
    }
    return { text: "", messages, approvals, artifacts, ...(threadId ? { threadId } : {}) };
  }

  #completeLines(): string[] {
    const parts = this.#buffer.split(/\r?\n/);
    this.#buffer = parts.pop() ?? "";
    return parts.filter((line) => line.length > 0);
  }
}

export function codexJsonArgs(baseArgs: readonly string[], prompt: string, resumeThreadId: string | undefined): string[] {
  if (resumeThreadId === undefined) {
    return [...baseArgs, prompt];
  }

  const [subcommand, ...rest] = baseArgs;
  return [
    subcommand ?? "exec",
    "resume",
    ...withoutExecOnlyArgs(rest),
    resumeThreadId,
    prompt,
  ];
}

function commandFor(kind: string, env: NodeJS.ProcessEnv): string {
  const override = env[`ROAMCLI_AGENT_${envKey(kind)}_COMMAND`];
  if (override !== undefined && override.trim().length > 0) {
    return override.trim();
  }
  return "codex";
}

function argsFor(kind: string, env: NodeJS.ProcessEnv): string[] {
  const override = env[`ROAMCLI_AGENT_${envKey(kind)}_ARGS`];
  if (override !== undefined) {
    return parseArgs(override);
  }
  return [...DEFAULT_ARGS];
}

function envKey(kind: string): string {
  return kind.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function withoutExecOnlyArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--color") {
      index += 1;
      continue;
    }
    result.push(arg);
  }
  return result;
}

export function parseArgs(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("Agent args override must be a JSON string array");
    }
    return parsed;
  }

  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) {
    current += "\\";
  }
  if (quote !== undefined) {
    throw new Error("Unterminated quote in agent args override");
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args;
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseTextDirectives(text: string): { approvals: ApprovalRequestDraft[]; artifacts: ArtifactDraft[] } {
  const approvals: ApprovalRequestDraft[] = [];
  const artifacts: ArtifactDraft[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const approval = parseApprovalLine(trimmed);
    if (approval !== undefined) {
      approvals.push(approval);
      continue;
    }
    const artifact = parseArtifactLine(trimmed);
    if (artifact !== undefined) {
      artifacts.push(artifact);
    }
  }
  return { approvals, artifacts };
}

function parseApprovalLine(line: string): ApprovalRequestDraft | undefined {
  const taggedJson =
    parseTaggedJson(line, "APPROVAL_REQUEST") ??
    parseTaggedJson(line, "ROAMCLI_APPROVAL");
  const json = taggedJson ?? parseJsonObject(line);
  if (json === undefined) {
    return undefined;
  }

  const approval = isRecord(json.approval) ? json.approval : json;
  const rawType = typeof json.type === "string" ? json.type : undefined;
  if (
    taggedJson === undefined &&
    rawType !== "approvalRequested" &&
    rawType !== "approval_request" &&
    rawType !== "approval"
  ) {
    return undefined;
  }

  const kind = approval.kind === "applyPatch" ? "applyPatch" : "execCommand";
  const summary =
    typeof approval.summary === "string" && approval.summary.length > 0
      ? approval.summary
      : "Agent requested approval";
  const payload = isRecord(approval.payload)
    ? approval.payload
    : taggedJson === undefined
      ? {}
      : approval;
  return { kind, summary, payload };
}

function parseArtifactLine(line: string): ArtifactDraft | undefined {
  const json =
    parseTaggedJson(line, "ARTIFACT") ??
    parseTaggedJson(line, "ROAMCLI_ARTIFACT") ??
    parseJsonObject(line);
  if (json === undefined) {
    return undefined;
  }
  if (json.type !== "artifact" && json.type !== "artifactCreated") {
    return undefined;
  }
  if (typeof json.path !== "string" || json.path.length === 0) {
    return undefined;
  }
  return {
    path: json.path,
    kind: json.kind === "patch" || json.kind === "log" ? json.kind : "file",
    mimeType:
      typeof json.mimeType === "string"
        ? json.mimeType
        : "application/octet-stream",
  };
}

function parseTaggedJson(line: string, tag: string): Record<string, unknown> | undefined {
  if (line.startsWith(`${tag}:`)) {
    return parseJsonObject(line.slice(tag.length + 1).trim());
  }
  if (line.startsWith(`${tag} `)) {
    return parseJsonObject(line.slice(tag.length + 1).trim());
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
