import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentInputUnavailableError,
  type AgentDefinition,
  type AgentInput,
  type AgentLaunchAttachment,
  type AgentPlugin,
  type AgentPluginContext,
  type AgentRuntimeConfigOptionsContext,
  type AgentRuntimeEvent,
  type AgentSession,
  type AgentSessionContext,
  type AgentSkillListContext,
} from "@roamcli/agent-plugin-sdk";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGES_PER_TURN,
  type AgentRuntimeModelOption,
  type AgentSkillSummary,
} from "@roamcli/shared/protocol";
import {
  PiRpc,
  PiRequestRejectedError,
  message,
  record,
  type RecordValue,
} from "./rpc.js";

const PLUGIN_NAME = "@roamcli/agent-pi";
const VERSION = "1.1.0";
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const extensionJs = fileURLToPath(
  new URL("./approval-extension.js", import.meta.url),
);
const EXTENSION_PATH = existsSync(extensionJs)
  ? extensionJs
  : fileURLToPath(new URL("./approval-extension.ts", import.meta.url));
const commandFor = (context: AgentPluginContext) =>
  context.env.ROAMCLI_AGENT_PI_COMMAND?.trim() || "pi";

export const piAgent: AgentDefinition = {
  kind: "pi",
  label: "Pi",
  buildCapability(context) {
    return {
      kind: "pi",
      label: "Pi",
      command: commandFor(context),
      args: ["--mode", "rpc"],
      parser: "pi-rpc",
      supportsResume: true,
      supportsDurableSessionStart: true,
      supportsImages: true,
      supportedImageMimeTypes: [...IMAGE_TYPES],
      maxImagesPerTurn: DEFAULT_MAX_IMAGES_PER_TURN,
      maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
      pluginName: PLUGIN_NAME,
      pluginVersion: VERSION,
      permissionNotice:
        context.profile === "trusted"
          ? "Pi tools run automatically with the Runner user's permissions. Pi has no OS sandbox."
          : "Pi requires approval for commands, file changes and custom tools. Pi has no OS sandbox.",
    };
  },
  createSession: (context) => new PiSession(context),
  listSkills: listPiSkills,
  listRuntimeConfigOptions: listPiRuntimeConfigOptions,
};
export const agentPlugin: AgentPlugin = {
  name: PLUGIN_NAME,
  version: VERSION,
  agents: () => [piAgent],
};
export default agentPlugin;

class PiSession implements AgentSession {
  readonly #context: AgentSessionContext;
  readonly #token = randomUUID();
  readonly #outputPrefix = `pi-${randomUUID()}`;
  readonly #deliveries = new Map<
    string,
    { content: string; promise: Promise<void> }
  >();
  readonly #tools = new Map<string, { name: string; args: RecordValue }>();
  readonly #pendingUI = new Set<string>();
  readonly #acceptanceWaiters = new Set<() => void>();
  #rpc: PiRpc | undefined;
  #closed = false;
  #started = false;
  #pendingInputs = 0;
  #settled: { aborted: boolean } | undefined;
  #failure: string | undefined;
  #events: Promise<void> = Promise.resolve();
  #outputId: string | undefined;
  #outputSequence = 0;
  #streamed = false;
  #readyResolve: (() => void) | undefined;
  #readyReject: ((error: Error) => void) | undefined;
  #readyTimer: ReturnType<typeof setTimeout> | undefined;
  #interrupting = false;
  #rpcReady = false;
  #finishing = false;
  #sessionFile: string | undefined;
  #sessionId: string | undefined;
  #snapshot: RecordValue | undefined;

  constructor(context: AgentSessionContext) {
    this.#context = context;
  }

  async start(): Promise<void> {
    if (this.#started || this.#closed) throw new AgentInputUnavailableError();
    this.#started = true;
    try {
      await this.#acceptOnUserWait(() => this.#initializeAndStart());
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async #initializeAndStart(): Promise<void> {
    try {
      if (this.#context.resumeThreadId)
        await verifyResume(this.#context.resumeThreadId, this.#context.cwd);
      const images = await imageInputs(this.#context.attachments ?? []);
      const ready = new Promise<void>((resolve, reject) => {
        this.#readyResolve = resolve;
        this.#readyReject = reject;
        this.#readyTimer = setTimeout(
          () =>
            reject(new Error("Pi did not load the RoamCli approval extension")),
          15_000,
        );
      });
      void ready.catch(() => undefined);
      const args = [
        "--mode",
        "rpc",
        "--extension",
        EXTENSION_PATH,
        ...(this.#context.resumeThreadId
          ? ["--session", this.#context.resumeThreadId]
          : ["--session-id", `roam-${this.#context.session.id}`]),
        ...runtimeArgs(this.#context),
      ];
      this.#rpc = new PiRpc({
        command: commandFor(this.#context),
        args,
        cwd: this.#context.cwd,
        env: {
          ...this.#context.env,
          ROAMCLI_PI_APPROVAL_TOKEN: this.#token,
          ROAMCLI_PI_PROFILE: this.#context.profile,
        },
        onEvent: (event) => {
          if (event.type === "extension_ui_request") {
            void this.#handleUI(event).catch((error) => this.#fail(error));
          } else {
            this.#events = this.#events
              .then(() => this.#handleEvent(event))
              .catch((error) => this.#fail(error));
          }
        },
        onFailure: (error) => {
          void this.#fail(error);
        },
      });
      const [state] = await Promise.all([
        this.#rpc.request("get_state"),
        ready,
      ]);
      this.#rpcReady = true;
      if (this.#closed) throw new AgentInputUnavailableError();
      if (
        typeof state.sessionFile !== "string" ||
        !isAbsolute(state.sessionFile)
      )
        throw new Error("Pi did not return a persistent session file");
      this.#sessionFile = state.sessionFile;
      this.#sessionId = String(state.sessionId);
      const selected = this.#context.session.agentRuntimeConfig?.model;
      if (selected && modelValue(record(state.model)) !== selected)
        throw new Error(
          "Pi selected a different model than the requested provider/model",
        );
      const effort = this.#context.session.agentRuntimeConfig?.reasoningEffort;
      if (effort) {
        const result = await this.#rpc.request("get_available_thinking_levels");
        if (!Array.isArray(result.levels) || !result.levels.includes(effort))
          throw new Error(`Pi model does not support thinking level ${effort}`);
      }
      if (
        images.length &&
        Array.isArray(record(state.model).input) &&
        !(record(state.model).input as unknown[]).includes("image")
      )
        throw new Error("The selected Pi model does not support images");
      await this.#emit({ type: "thread", threadId: state.sessionFile });
      await this.#submit(this.#context.prompt, images);
    } finally {
      if (this.#readyTimer) clearTimeout(this.#readyTimer);
      this.#readyResolve = undefined;
      this.#readyReject = undefined;
    }
  }

  deliverInput(input: AgentInput): Promise<void> {
    if (this.#closed || this.#finishing || !this.#rpc)
      return Promise.reject(new AgentInputUnavailableError());
    if (input.deliveryId) {
      const existing = this.#deliveries.get(input.deliveryId);
      if (existing)
        return existing.content === input.content
          ? existing.promise
          : Promise.reject(
              new AgentInputUnavailableError(
                "Input delivery ID was reused with different content",
              ),
            );
      const promise = this.#submit(input.content);
      this.#deliveries.set(input.deliveryId, {
        content: input.content,
        promise,
      });
      void promise.catch((error) => {
        if (
          error instanceof PiRequestRejectedError &&
          this.#deliveries.get(input.deliveryId!)?.promise === promise
        )
          this.#deliveries.delete(input.deliveryId!);
      });
      return promise;
    }
    return this.#submit(input.content);
  }

  async #submit(content: string, images: RecordValue[] = []): Promise<void> {
    return this.#acceptOnUserWait(() => this.#runPrompt(content, images));
  }

  async #runPrompt(content: string, images: RecordValue[]): Promise<void> {
    if (this.#closed || !this.#rpc) throw new AgentInputUnavailableError();
    this.#pendingInputs++;
    this.#settled = undefined;
    try {
      // prompt+steer handles both idle and running sessions atomically on Pi's side.
      const response = await this.#rpc.request("prompt", {
        message: content,
        streamingBehavior: "steer",
        ...(images.length ? { images } : {}),
      });
      if (response.disposition === "handled") {
        const state = await this.#rpc.request("get_state");
        if (
          !state.isStreaming &&
          !state.isCompacting &&
          !state.pendingMessageCount
        ) {
          this.#settled = { aborted: false };
        }
      }
    } finally {
      this.#pendingInputs--;
      this.#events = this.#events
        .then(() => this.#finishIfSettled())
        .catch((error) => this.#fail(error));
    }
  }

  #acceptOnUserWait(operation: () => Promise<void>): Promise<void> {
    let acceptedEarly = false;
    let accept!: () => void;
    const ownership = new Promise<void>((resolve) => {
      accept = () => {
        acceptedEarly = true;
        resolve();
      };
    });
    this.#acceptanceWaiters.add(accept);
    const work = operation();
    void work
      .catch((error) => {
        if (acceptedEarly) return this.#fail(error);
      })
      .finally(() => {
        this.#acceptanceWaiters.delete(accept);
      });
    // A dialog proves Pi has entered the command handler. Own the input now so
    // Runner can deliver the answer; waiting for the handler's response would
    // block the command channel and its acceptance deadline.
    return Promise.race([work, ownership]);
  }

  async control(signal: "interrupt" | "stop" | "resume"): Promise<void> {
    if (signal === "resume" || this.#closed) return;
    this.#interrupting = true;
    try {
      for (const id of this.#pendingUI)
        this.#rpc?.send({ type: "extension_ui_response", id, cancelled: true });
      this.#pendingUI.clear();
      this.#rpc?.setWaitingForUser(false);
      await this.#rpc?.request("clear_queue", {}, 3000);
      await this.#rpc?.request("abort", {}, 5000);
    } finally {
      if (!this.#closed) {
        this.#closed = true;
        this.#rpc?.close();
        await this.#emit({ type: "status", status: "stopped" });
      }
    }
  }

  close(): void {
    this.#closed = true;
    if (this.#readyTimer) clearTimeout(this.#readyTimer);
    this.#readyReject?.(new AgentInputUnavailableError());
    this.#rpc?.close();
  }

  async #handleEvent(event: RecordValue): Promise<void> {
    if (this.#closed) return;
    const msg = record(event.message);
    if (event.type === "agent_start") {
      this.#settled = undefined;
      await this.#emit({ type: "status", status: "running" });
    } else if (event.type === "message_start" && msg.role === "assistant") {
      this.#outputId = `${this.#outputPrefix}-${++this.#outputSequence}`;
      this.#streamed = false;
    } else if (event.type === "message_update") {
      const delta = record(event.assistantMessageEvent);
      if (delta.type === "text_delta" && typeof delta.delta === "string") {
        this.#outputId ??= `${this.#outputPrefix}-${++this.#outputSequence}`;
        this.#streamed = true;
        await this.#emit({
          type: "assistantOutput",
          outputId: this.#outputId,
          content: delta.delta,
          mode: "append",
          done: false,
        });
      } else if (delta.type === "thinking_start") {
        await this.#activity("thought", "Thinking");
      } else if (
        delta.type === "thinking_end" &&
        typeof delta.content === "string" &&
        delta.content.trim()
      ) {
        await this.#activity("thought", delta.content);
      }
    } else if (event.type === "message_end" && msg.role === "assistant") {
      const text = textContent(msg.content);
      if (text || this.#streamed) {
        this.#outputId ??= `${this.#outputPrefix}-${++this.#outputSequence}`;
        await this.#emit({
          type: "assistantOutput",
          outputId: this.#outputId,
          content: text,
          mode: "replace",
          done: true,
        });
      }
      this.#outputId = undefined;
      this.#streamed = false;
      this.#failure =
        msg.stopReason === "error"
          ? String(msg.errorMessage ?? "Pi model request failed")
          : undefined;
    } else if (event.type === "tool_execution_start") {
      const name = String(event.toolName ?? "tool");
      const args = record(event.args);
      this.#tools.set(String(event.toolCallId), { name, args });
      await this.#activity(
        "tool",
        `${name}: ${String(args.command ?? args.path ?? args.pattern ?? "running")}`,
      );
    } else if (event.type === "tool_execution_end") {
      const tool = this.#tools.get(String(event.toolCallId));
      this.#tools.delete(String(event.toolCallId));
      const result = textContent(record(event.result).content);
      await this.#activity(
        "tool",
        `${String(event.toolName)}: ${event.isError ? "failed" : "finished"}${result ? `\n${result}` : ""}`,
      );
      if (
        !event.isError &&
        tool &&
        ["write", "edit"].includes(tool.name) &&
        typeof tool.args.path === "string"
      ) {
        await this.#emit({
          type: "artifact",
          draft: { path: tool.args.path, kind: "file" },
        });
      }
    } else if (event.type === "agent_settled") {
      this.#settled = { aborted: event.aborted === true };
      await this.#finishIfSettled();
    } else if (event.type === "extension_error") {
      if (
        String(event.extensionPath).replaceAll("\\", "/") ===
        EXTENSION_PATH.replaceAll("\\", "/")
      )
        throw new Error(`Pi approval extension failed: ${String(event.error)}`);
      await this.#activity(
        "system",
        `Pi extension error: ${String(event.error)}`,
      );
    } else if (
      event.type === "compaction_start" ||
      event.type === "auto_retry_start"
    ) {
      await this.#activity(
        "status",
        event.type === "compaction_start"
          ? "Compacting context"
          : `Retrying model request (${String(event.attempt)})`,
      );
    } else if (event.type === "auto_retry_end" && event.success === false) {
      this.#failure = String(event.finalError ?? "Pi retries exhausted");
    } else if (
      event.type === "compaction_end" &&
      event.errorMessage &&
      !event.willRetry &&
      !event.aborted
    ) {
      this.#failure = String(event.errorMessage);
    }
  }

  async #finishIfSettled(): Promise<void> {
    if (
      this.#closed ||
      !this.#settled ||
      this.#pendingInputs ||
      this.#interrupting ||
      this.#finishing
    )
      return;
    if (this.#failure && !this.#interrupting && !this.#settled.aborted)
      return this.#fail(new Error(this.#failure));
    this.#finishing = true;
    await this.#persistNativeIfNeeded();
    if (this.#closed || this.#interrupting) return;
    this.#closed = true;
    this.#rpc?.close();
    await this.#emit({
      type: "status",
      status:
        this.#interrupting || this.#settled.aborted ? "stopped" : "completed",
    });
  }

  async #handleUI(event: RecordValue): Promise<void> {
    if (this.#closed) return;
    if (
      event.method === "notify" &&
      event.message === `roamcli-ready:${this.#token}`
    ) {
      if (this.#readyTimer) clearTimeout(this.#readyTimer);
      this.#readyResolve?.();
      return;
    }
    if (
      event.method === "notify" &&
      typeof event.message === "string" &&
      event.message.startsWith(`roamcli-snapshot:${this.#token}:`)
    ) {
      this.#snapshot = record(
        JSON.parse(
          event.message.slice(`roamcli-snapshot:${this.#token}:`.length),
        ),
      );
      return;
    }
    const response: RecordValue = {
      type: "extension_ui_response",
      id: event.id,
    };
    const dialog = ["select", "confirm", "input", "editor"].includes(
      String(event.method),
    );
    if (dialog) {
      if (!this.#rpcReady) {
        throw new Error(
          "Pi RPC does not support extension dialogs during startup. Move the dialog to an extension command or tool hook, or adjust the local Pi extension before starting a RoamCli session.",
        );
      }
      if (this.#interrupting) {
        this.#rpc?.send({ ...response, cancelled: true });
        return;
      }
      this.#pendingUI.add(String(event.id));
      this.#rpc?.setWaitingForUser(true);
      if (this.#readyTimer) clearTimeout(this.#readyTimer);
      for (const accept of this.#acceptanceWaiters) accept();
    }
    try {
      if (
        event.method === "confirm" &&
        event.title === `roamcli-approval:${this.#token}`
      ) {
        const tool = record(JSON.parse(String(event.message)));
        const kind = ["write", "edit"].includes(String(tool.toolName))
          ? "applyPatch"
          : "execCommand";
        const decision = await this.#context.requestApproval({
          kind,
          summary: `Pi wants to use ${String(tool.toolName)}`,
          payload: {
            source: "pi-rpc",
            toolName: tool.toolName,
            input: tool.input,
          },
        });
        response.confirmed = decision.approved;
      } else if (
        ["select", "confirm", "input", "editor"].includes(String(event.method))
      ) {
        if (!this.#context.requestUserInput)
          throw new Error("RoamCli user input is unavailable");
        const options =
          event.method === "confirm"
            ? ["Yes", "No"]
            : Array.isArray(event.options)
              ? event.options.filter(
                  (value): value is string => typeof value === "string",
                )
              : [];
        const title = String(event.title ?? "Pi requests input");
        const answer = await this.#context.requestUserInput({
          summary: title,
          questions: [
            {
              id: String(event.id),
              header: "Pi",
              question: [
                title,
                event.message,
                event.placeholder,
                event.prefill,
                options.length
                  ? `Reply with one of: ${options.join(", ")}`
                  : "",
              ]
                .filter((value) => typeof value === "string" && value)
                .join("\n"),
              isOther: false,
              isSecret: false,
            },
          ],
          payload: { source: "pi-rpc", method: event.method },
        });
        if (event.method === "confirm")
          response.confirmed = answer.content.trim().toLowerCase() === "yes";
        else if (event.method === "select" && !options.includes(answer.content))
          response.cancelled = true;
        else response.value = answer.content;
      } else {
        if (event.method === "notify" && typeof event.message === "string")
          await this.#activity("system", event.message);
        return;
      }
    } catch {
      response.cancelled = true;
    }
    if (!this.#closed && this.#pendingUI.delete(String(event.id))) {
      this.#rpc?.send(response);
      if (!this.#pendingUI.size) {
        this.#rpc?.setWaitingForUser(false);
      }
    }
  }

  async #persistNativeIfNeeded(): Promise<void> {
    const path = this.#sessionFile;
    if (!path || this.#closed) return;
    try {
      await stat(path);
      return;
    } catch (error) {
      if (record(error).code !== "ENOENT") throw error;
    }
    // Pi intentionally keeps setup/extension-only sessions in memory. Obtain
    // its exact public session snapshot after the command settles and save it
    // before closing. Never fabricate a native header or overwrite a file Pi
    // has already persisted. There are no further prompts in this process.
    this.#snapshot = undefined;
    await this.#rpc?.request("prompt", {
      message: `/roamcli-state-${this.#token}`,
    });
    const snapshot = this.#snapshot as RecordValue | undefined;
    const header = record(snapshot?.header);
    if (
      header.type !== "session" ||
      header.id !== this.#sessionId ||
      typeof header.cwd !== "string" ||
      !Array.isArray(snapshot?.entries)
    )
      throw new Error("Pi did not return a valid native session snapshot");
    if ((await realpath(header.cwd)) !== (await realpath(this.#context.cwd)))
      throw new Error("Pi session directory changed unexpectedly");
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if (record(error).code === "EEXIST") return;
      throw error;
    }
    try {
      await handle.writeFile(
        [header, ...snapshot.entries]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #fail(error: unknown): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#readyReject?.(
      error instanceof Error ? error : new Error(message(error)),
    );
    if (this.#readyTimer) clearTimeout(this.#readyTimer);
    this.#rpc?.close(
      true,
      error instanceof Error ? error : new Error(message(error)),
    );
    await this.#emit({
      type: "error",
      message: message(error),
      code: "PI_ERROR",
    });
    await this.#emit({ type: "status", status: "failed" });
  }
  #emit(event: AgentRuntimeEvent): Promise<void> {
    return this.#context.emit(event);
  }
  #activity(
    kind: "tool" | "thought" | "system" | "status",
    label: string,
  ): Promise<void> {
    return this.#emit({ type: "activity", kind, label: label.slice(0, 2000) });
  }
}

function textContent(content: unknown): string {
  return Array.isArray(content)
    ? content
        .map(record)
        .filter(
          (block) => block.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text)
        .join("")
    : "";
}
export function modelValue(model: RecordValue): string {
  return `${encodeURIComponent(String(model.provider))}/${String(model.id)}`;
}
function runtimeArgs(context: AgentSessionContext): string[] {
  const config = context.session.agentRuntimeConfig;
  if (config?.fastMode || config?.serviceTier)
    throw new Error(
      "Pi does not expose RoamCli fast mode or service tier controls",
    );
  const args: string[] = [];
  if (config?.model) {
    const separator = config.model.indexOf("/");
    if (separator <= 0 || separator === config.model.length - 1)
      throw new Error(
        "Pi model must include its provider; select a model from the available models",
      );
    args.push(
      "--provider",
      decodeURIComponent(config.model.slice(0, separator)),
      "--model",
      config.model.slice(separator + 1),
    );
  }
  if (config?.reasoningEffort) {
    if (!THINKING_LEVELS.includes(config.reasoningEffort))
      throw new Error("Invalid Pi thinking level");
    args.push("--thinking", config.reasoningEffort);
  }
  return args;
}

async function imageInputs(
  attachments: readonly AgentLaunchAttachment[],
): Promise<RecordValue[]> {
  if (attachments.length > DEFAULT_MAX_IMAGES_PER_TURN)
    throw new Error("Too many Pi image attachments");
  return Promise.all(
    attachments.map(async (attachment) => {
      if (!IMAGE_TYPES.includes(attachment.mimeType))
        throw new Error(`Unsupported Pi image type: ${attachment.mimeType}`);
      if ((await stat(attachment.localPath)).size > DEFAULT_MAX_IMAGE_BYTES)
        throw new Error("Pi image exceeds the size limit");
      const data = await readFile(attachment.localPath);
      if (data.length > DEFAULT_MAX_IMAGE_BYTES)
        throw new Error("Pi image exceeds the size limit");
      return {
        type: "image",
        data: data.toString("base64"),
        mimeType: attachment.mimeType,
      };
    }),
  );
}

async function verifyResume(path: string, cwd: string): Promise<void> {
  if (!isAbsolute(path))
    throw new Error("Pi resume requires an absolute session file path");
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const header = record(
      JSON.parse(
        buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "",
      ),
    );
    if (header.type !== "session" || typeof header.cwd !== "string")
      throw new Error("Invalid Pi session header");
    if ((await realpath(header.cwd)) !== (await realpath(cwd)))
      throw new Error(
        "Pi session belongs to a different project directory; restore the original directory or create a new RoamCli session",
      );
  } finally {
    await handle.close();
  }
}

async function withDiscovery<T>(
  context: AgentRuntimeConfigOptionsContext | AgentSkillListContext,
  run: (rpc: PiRpc) => Promise<T>,
): Promise<T> {
  const rpc = new PiRpc({
    command: commandFor(context),
    args: ["--mode", "rpc", "--no-session"],
    cwd: context.basePath,
    env: context.env,
    onEvent: (event) => {
      if (
        event.type === "extension_ui_request" &&
        ["select", "confirm", "input", "editor"].includes(String(event.method))
      ) {
        rpc.send({
          type: "extension_ui_response",
          id: event.id,
          cancelled: true,
        });
      }
    },
    onFailure: () => undefined,
  });
  try {
    return await run(rpc);
  } finally {
    rpc.close();
  }
}

export async function listPiRuntimeConfigOptions(
  context: AgentRuntimeConfigOptionsContext,
) {
  const base = {
    models: [] as AgentRuntimeModelOption[],
    allowCustomModel: false,
    reasoningEfforts: [],
    fastMode: { kind: "unsupported" as const, supported: false as const },
  };
  try {
    return await withDiscovery(context, async (rpc) => {
      const result = await rpc.request("get_available_models");
      const models = (Array.isArray(result.models) ? result.models : [])
        .map(record)
        .filter(
          (model) =>
            typeof model.provider === "string" && typeof model.id === "string",
        )
        .map((model): AgentRuntimeModelOption => {
          // This is Pi's public Model.thinkingLevelMap contract. Do not switch
          // models just to discover levels: set_model persists native settings.
          const map = record(model.thinkingLevelMap);
          const levels = !model.reasoning
            ? ["off"]
            : THINKING_LEVELS.filter(
                (level) =>
                  map[level] !== null &&
                  (!["xhigh", "max"].includes(level) ||
                    map[level] !== undefined),
              );
          return {
            value: modelValue(model),
            label: `${String(model.name ?? model.id)} (${String(model.provider)})`,
            description: String(model.id),
            reasoningEfforts: levels.map((value) => ({ value, label: value })),
            serviceTiers: [],
          };
        });
      return {
        ...base,
        models,
        ...(models.length
          ? {}
          : {
              error:
                "No available Pi models. Configure authentication and models on the Runner machine using Pi.",
            }),
      };
    });
  } catch (error) {
    return { ...base, error: message(error) };
  }
}

export async function listPiSkills(
  context: AgentSkillListContext,
): Promise<readonly AgentSkillSummary[]> {
  return withDiscovery(context, async (rpc) => {
    const result = await rpc.request("get_commands");
    return (Array.isArray(result.commands) ? result.commands : [])
      .map(record)
      .filter(
        (command) =>
          command.source === "skill" &&
          typeof command.name === "string" &&
          typeof record(command.sourceInfo).path === "string",
      )
      .map((command) => ({
        name: String(command.name).replace(/^skill:/, ""),
        ...(typeof command.description === "string"
          ? { description: command.description }
          : {}),
        insertText: `/${String(command.name).startsWith("skill:") ? command.name : `skill:${String(command.name)}`}`,
        sourceType:
          record(command.sourceInfo).scope === "user"
            ? ("global" as const)
            : ("project" as const),
        sourcePath: String(record(command.sourceInfo).path),
      }));
  });
}
