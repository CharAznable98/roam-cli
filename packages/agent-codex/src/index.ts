import {
  execFile,
  spawn as spawnChild,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type {
  AgentDefinition,
  AgentInput,
  AgentOutputParser,
  AgentParseResult,
  AgentPlugin,
  AgentPluginContext,
  AgentSession,
  AgentSessionContext,
  AssistantOutputEvent,
  ApprovalRequestDraft,
  ArtifactDraft,
} from "@roamcli/agent-plugin-sdk";
import {
  type AgentSkillSummary,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGES_PER_TURN,
  type RunnerCapability,
} from "@roamcli/shared/protocol";
import { CodexAppServerSession } from "./app-server-session.js";
import { parseJsonObject, parseTextDirectives } from "./directives.js";

const execFileAsync = promisify(execFile);
const KIND = "codex";
const PLUGIN_NAME = "@roamcli/agent-codex";
const PLUGIN_VERSION = "1.1.0";
const SUPPORTED_IMAGE_MIME_TYPES = ["image/png", "image/jpeg"];
const DEFAULT_APP_SERVER_ARGS = [
  "app-server",
  "--stdio",
  "-c",
  "skip_git_repo_check=true",
];
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
      args:
        modeFor(KIND, context.env) === "exec-json"
          ? argsFor(KIND, context.env)
          : appServerArgsFor(KIND, context.env),
      parser:
        modeFor(KIND, context.env) === "exec-json"
          ? "codex-json"
          : "codex-app-server",
      supportsResume: true,
      supportsImages: true,
      supportedImageMimeTypes: SUPPORTED_IMAGE_MIME_TYPES,
      maxImagesPerTurn: DEFAULT_MAX_IMAGES_PER_TURN,
      maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
      pluginName: PLUGIN_NAME,
      pluginVersion: PLUGIN_VERSION,
    };
  },
  createSession(context: AgentSessionContext): AgentSession {
    if (modeFor(KIND, context.env) === "app-server") {
      return new CodexAppServerSession({
        command: commandFor(KIND, context.env),
        args: appServerArgsFor(KIND, context.env),
        context,
      });
    }
    return new CodexProcessSession({
      command: commandFor(KIND, context.env),
      args: codexJsonArgs(
        argsFor(KIND, context.env),
        context.prompt,
        context.resumeThreadId,
        imagePaths(context),
      ),
      cwd: context.cwd,
      env: context.env,
      parser: new CodexJsonParser(),
      context,
    });
  },
  async listSkills(context) {
    return listCodexSkills(context.workspace, context.basePath, context.env);
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

interface CodexProcessSessionOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  parser: AgentOutputParser;
  context: AgentSessionContext;
}

class CodexProcessSession implements AgentSession {
  readonly #options: CodexProcessSessionOptions;
  #child?: ChildProcessWithoutNullStreams;
  #stopRequested = false;
  #failed = false;
  readonly #outputTasks = new Set<Promise<void>>();
  readonly #approvalTasks = new Set<Promise<void>>();

  public constructor(options: CodexProcessSessionOptions) {
    this.#options = options;
  }

  public async start(): Promise<void> {
    const child = spawnChild(this.#options.command, [...this.#options.args], {
      cwd: this.#options.cwd,
      env: this.#options.env,
      stdio: "pipe",
    });
    this.#child = child;

    child.stdout.on("data", (chunk) => this.#trackOutput(chunk));
    child.stderr.on("data", (chunk) => this.#trackOutput(chunk));
    child.on("error", (error) => {
      void this.#options.context.emit({
        type: "error",
        message: error.message,
        code: "SPAWN_ERROR",
      });
    });
    child.on("close", (code, signal) => {
      void this.#finish(code, signal).catch(() => undefined);
    });
    if (shouldCloseStdinAfterStart(this.#options.args)) {
      child.stdin.end();
    }
  }

  public deliverInput(input: AgentInput): void {
    const child = this.#child;
    if (!child) {
      return;
    }
    this.#write(input.content);
    if (!input.content.endsWith("\n")) {
      this.#write("\n");
    }
  }

  public control(signal: "interrupt" | "stop" | "resume"): void {
    const child = this.#child;
    if (!child) {
      return;
    }
    if (signal === "interrupt") {
      child.kill("SIGINT");
      return;
    }
    if (signal === "stop") {
      this.#stopRequested = true;
      child.kill("SIGTERM");
      return;
    }
    this.#write(`${JSON.stringify({ type: "controlSignal", signal })}\n`);
  }

  public close(): void {
    this.#stopRequested = true;
    this.#child?.kill("SIGKILL");
  }

  #trackOutput(chunk: string | Buffer): void {
    this.#trackTask(this.#handleOutput(chunk), this.#outputTasks);
  }

  #trackTask(task: Promise<void>, tasks: Set<Promise<void>>): void {
    tasks.add(task);
    void task
      .finally(() => {
        tasks.delete(task);
      })
      .catch(() => undefined);
  }

  async #finish(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    const stopped =
      this.#stopRequested ||
      (!this.#failed && (signal === "SIGTERM" || signal === "SIGINT"));
    await this.#waitForTasks(this.#outputTasks);
    if (!stopped) {
      await this.#waitForTasks(this.#approvalTasks);
    }
    await this.#options.context.emit({
      type: "status",
      status: statusForExit(code, stopped, this.#failed),
    });
  }

  async #waitForTasks(tasks: Set<Promise<void>>): Promise<void> {
    while (tasks.size > 0) {
      await Promise.allSettled([...tasks]);
    }
  }

  async #handleOutput(chunk: string | Buffer): Promise<void> {
    let parsed: AgentParseResult;
    try {
      parsed = this.#options.parser.feed(chunk);
    } catch {
      return;
    }
    if (parsed.threadId !== undefined) {
      await this.#options.context.emit({
        type: "thread",
        threadId: parsed.threadId,
      });
    }
    for (const output of parsed.assistantOutputs ?? []) {
      await this.#options.context.emit(output);
    }
    for (const draft of parsed.approvals) {
      this.#trackTask(this.#requestApproval(draft), this.#approvalTasks);
    }
    for (const draft of parsed.artifacts) {
      await this.#options.context.emit({ type: "artifact", draft });
    }
  }

  async #requestApproval(draft: ApprovalRequestDraft): Promise<void> {
    try {
      const decision = await this.#options.context.requestApproval(draft);
      this.#write(`${JSON.stringify(approvalResponsePayload(decision))}\n`);
    } catch (error: unknown) {
      this.#failed = true;
      try {
        await this.#options.context.emit({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
          code: "CODEX_APPROVAL_ERROR",
        });
      } catch {
        // The child must not wait forever even when the runner event sink is down.
      } finally {
        this.#child?.kill("SIGTERM");
      }
    }
  }

  #write(data: string): void {
    const child = this.#child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) {
      return;
    }
    child.stdin.write(data);
  }
}

export function approvalResponsePayload(decision: {
  approvalId: string;
  approved: boolean;
  signedAt: string;
  signature: string;
}): {
  type: "approvalResponse";
  approvalId: string;
  approved: boolean;
  signedAt: string;
  signature: string;
} {
  return {
    type: "approvalResponse",
    approvalId: decision.approvalId,
    approved: decision.approved,
    signedAt: decision.signedAt,
    signature: decision.signature,
  };
}

function statusForExit(
  code: number | null,
  stopped: boolean,
  failed: boolean,
): "completed" | "failed" | "stopped" {
  if (stopped) {
    return "stopped";
  }
  if (failed) {
    return "failed";
  }
  return code === 0 ? "completed" : "failed";
}

export class CodexJsonParser implements AgentOutputParser {
  #buffer = "";
  #outputSequence = 0;
  readonly #outputPrefix = `codex-run-${randomUUID()}`;

  feed(chunk: string | Buffer): AgentParseResult {
    this.#buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    const assistantOutputs: AssistantOutputEvent[] = [];
    let threadId: string | undefined;
    const approvals: ApprovalRequestDraft[] = [];
    const artifacts: ArtifactDraft[] = [];
    const lines = this.#completeLines();
    for (const line of lines) {
      const event = parseJsonObject(line);
      if (
        event?.type === "thread.started" &&
        typeof event.thread_id === "string"
      ) {
        threadId = event.thread_id;
        continue;
      }
      if (event?.type !== "item.completed" || !isRecord(event.item)) {
        continue;
      }
      if (
        event.item.type !== "agent_message" ||
        typeof event.item.text !== "string"
      ) {
        continue;
      }
      const directives = parseTextDirectives(event.item.text);
      approvals.push(...directives.approvals);
      artifacts.push(...directives.artifacts);
      assistantOutputs.push({
        type: "assistantOutput",
        outputId:
          typeof event.item.id === "string"
            ? this.#scopedOutputId(event.item.id)
            : this.#nextOutputId(),
        content: event.item.text,
        mode: "replace",
        done: true,
      });
    }
    return {
      assistantOutputs,
      approvals,
      artifacts,
      ...(threadId ? { threadId } : {}),
    };
  }

  #completeLines(): string[] {
    const parts = this.#buffer.split(/\r?\n/);
    this.#buffer = parts.pop() ?? "";
    return parts.filter((line) => line.length > 0);
  }

  #nextOutputId(): string {
    this.#outputSequence += 1;
    return this.#scopedOutputId(`codex-output-${this.#outputSequence}`);
  }

  #scopedOutputId(outputId: string): string {
    return `${this.#outputPrefix}:${outputId}`;
  }
}

export function codexJsonArgs(
  baseArgs: readonly string[],
  prompt: string,
  resumeThreadId: string | undefined,
  images: readonly string[] = [],
): string[] {
  const imageArgs = images.flatMap((image) => ["--image", image]);
  if (resumeThreadId === undefined) {
    return [...baseArgs, prompt, ...imageArgs];
  }

  const [subcommand, ...rest] = baseArgs;
  return [
    subcommand ?? "exec",
    "resume",
    ...withoutExecOnlyArgs(rest),
    resumeThreadId,
    prompt,
    ...imageArgs,
  ];
}

function imagePaths(context: AgentSessionContext): string[] {
  return (context.attachments ?? [])
    .filter((attachment) => attachment.kind === "image")
    .map((attachment) => attachment.localPath);
}

export async function listCodexSkills(
  workspace: string,
  basePath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentSkillSummary[]> {
  const base = await resolveSkillBase(workspace, basePath);
  if (!base) {
    return [];
  }

  const roots = await skillRootsForBase(
    base.path,
    base.realPath,
    base.realWorkspace,
  );
  roots.push(...globalSkillRoots(env));

  const skills: AgentSkillSummary[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const discovered = await readSkillRoot(root.path, root.type);
    for (const skill of discovered) {
      if (seen.has(skill.name)) {
        continue;
      }
      seen.add(skill.name);
      skills.push(skill);
    }
  }
  return skills;
}

function globalSkillRoots(
  env: NodeJS.ProcessEnv,
): Array<{ type: "global"; path: string }> {
  const home = env.HOME && env.HOME.trim().length > 0 ? env.HOME : homedir();
  const roots = [
    ...(env.CODEX_HOME && env.CODEX_HOME.trim().length > 0
      ? [join(env.CODEX_HOME, "skills")]
      : []),
    join(home, ".agents", "skills"),
    join(home, ".codex", "skills"),
  ];
  const seen = new Set<string>();
  return roots.flatMap((root) => {
    const normalized = resolve(root);
    if (seen.has(normalized)) {
      return [];
    }
    seen.add(normalized);
    return [{ type: "global" as const, path: root }];
  });
}

async function resolveSkillBase(
  workspace: string,
  basePath: string,
): Promise<
  { path: string; realPath: string; realWorkspace: string } | undefined
> {
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
    return { path: candidate, realPath: realCandidate, realWorkspace };
  } catch {
    return undefined;
  }
}

async function skillRootsForBase(
  basePath: string,
  realBasePath: string,
  realWorkspace: string,
): Promise<Array<{ type: "project" | "global"; path: string }>> {
  const repoRoot = await gitRoot(realBasePath);
  const realStop =
    repoRoot &&
    isInside(realWorkspace, repoRoot) &&
    isInside(repoRoot, realBasePath)
      ? repoRoot
      : realBasePath;
  const roots: Array<{ type: "project"; path: string }> = [];
  let current = realBasePath;
  while (isInside(realStop, current)) {
    roots.push(
      { type: "project", path: join(current, ".agents", "skills") },
      { type: "project", path: join(current, ".codex", "skills") },
    );
    if (current === realStop) {
      break;
    }
    const next = dirname(current);
    if (next === current) {
      break;
    }
    current = next;
  }
  if (realBasePath !== basePath && roots.length === 0) {
    roots.push(
      { type: "project", path: join(basePath, ".agents", "skills") },
      { type: "project", path: join(basePath, ".codex", "skills") },
    );
  }
  return roots;
}

async function gitRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      { timeout: 3000 },
    );
    const value = stdout.trim();
    return value ? await realpath(value) : undefined;
  } catch {
    return undefined;
  }
}

async function readSkillRoot(
  root: string,
  sourceType: "project" | "global",
): Promise<AgentSkillSummary[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: AgentSkillSummary[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sourcePath = join(root, entry.name);
    const metadata = await readSkillMetadata(join(sourcePath, "SKILL.md"));
    if (!metadata) {
      continue;
    }
    skills.push({
      name: metadata.name,
      ...(metadata.description ? { description: metadata.description } : {}),
      sourceType,
      sourcePath,
    });
  }
  return skills;
}

async function readSkillMetadata(
  path: string,
): Promise<{ name: string; description?: string } | undefined> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const frontmatter = parseFrontmatter(content);
  const name = frontmatter.get("name")?.trim();
  if (!name) {
    return undefined;
  }
  const description = frontmatter.get("description")?.trim();
  return {
    name,
    ...(description ? { description } : {}),
  };
}

function parseFrontmatter(content: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!content.startsWith("---")) {
    return result;
  }
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return result;
  }
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    if (line.trim() === "---") {
      break;
    }
    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const value = unquoteFrontmatterValue(
      line.slice(separatorIndex + 1).trim(),
    );
    result.set(key, value);
  }
  return result;
}

function unquoteFrontmatterValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
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

function appServerArgsFor(kind: string, env: NodeJS.ProcessEnv): string[] {
  const override = env[`ROAMCLI_AGENT_${envKey(kind)}_APP_SERVER_ARGS`];
  if (override !== undefined) {
    return parseArgs(override);
  }
  return [...DEFAULT_APP_SERVER_ARGS];
}

function modeFor(kind: string, env: NodeJS.ProcessEnv): "app-server" | "exec-json" {
  const mode = env[`ROAMCLI_AGENT_${envKey(kind)}_MODE`]?.trim();
  if (mode === undefined || mode.length === 0 || mode === "app-server") {
    return "app-server";
  }
  if (mode === "exec-json") {
    return "exec-json";
  }
  throw new Error(
    `Unsupported Codex agent mode: ${mode}. Expected app-server or exec-json`,
  );
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

function shouldCloseStdinAfterStart(args: readonly string[]): boolean {
  return args.includes("--dangerously-bypass-approvals-and-sandbox");
}

export function parseArgs(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      !Array.isArray(parsed) ||
      parsed.some((item) => typeof item !== "string")
    ) {
      throw new Error("Agent args override must be a JSON string array");
    }
    return parsed;
  }

  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
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
    if (char === "'" || char === '"') {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
