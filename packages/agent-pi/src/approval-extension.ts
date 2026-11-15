// Loaded by the user's Pi runtime. Structural types avoid bundling a second Pi
// SDK/version in the Runner; the extension only uses the public extension API.
import { existsSync } from "node:fs";

interface PiContext {
  sessionManager: {
    getHeader(): unknown;
    getEntries(): readonly unknown[];
    getSessionFile(): string | undefined;
  };
  hasUI: boolean;
  ui: {
    notify(message: string, type?: string): void;
    confirm(title: string, message: string): Promise<boolean>;
  };
}
interface PiExtensionAPI {
  registerCommand(
    name: string,
    options: {
      description: string;
      handler(args: string, ctx: PiContext): Promise<void>;
    },
  ): void;
  on(
    event: "session_start" | "session_shutdown",
    handler: (event: unknown, ctx: PiContext) => void,
  ): void;
  on(
    event: "tool_call",
    handler: (
      event: { toolName: string; input: unknown },
      ctx: PiContext,
    ) => Promise<{ block: true; reason: string } | undefined>,
  ): void;
}

export default function approvalExtension(pi: PiExtensionAPI): void {
  const token = process.env.ROAMCLI_PI_APPROVAL_TOKEN;
  const trusted = process.env.ROAMCLI_PI_PROFILE === "trusted";
  const snapshot = (ctx: PiContext) => {
    const path = ctx.sessionManager.getSessionFile();
    // Durable histories already belong to Pi. Avoid serializing their images
    // and full transcripts into the RPC bridge just to protect an empty file.
    if (path && existsSync(path)) return;
    if (token)
      ctx.ui.notify(
        `roamcli-snapshot:${token}:${JSON.stringify({ header: ctx.sessionManager.getHeader(), entries: ctx.sessionManager.getEntries() })}`,
        "info",
      );
  };
  if (token)
    pi.registerCommand(`roamcli-state-${token}`, {
      description: "Persist the RoamCli-managed session",
      handler: async (_args, ctx) => {
        snapshot(ctx);
      },
    });
  pi.on("session_start", (_event, ctx) => {
    // Keep an authentic native identity even if a later hook never returns.
    snapshot(ctx);
    if (token) ctx.ui.notify(`roamcli-ready:${token}`, "info");
  });
  pi.on("session_shutdown", (_event, ctx) => snapshot(ctx));
  pi.on("tool_call", async (event, ctx) => {
    if (trusted || ["read", "grep", "find", "ls"].includes(event.toolName))
      return;
    try {
      if (
        token &&
        ctx.hasUI &&
        (await ctx.ui.confirm(
          `roamcli-approval:${token}`,
          JSON.stringify({ toolName: event.toolName, input: event.input }),
        ))
      )
        return;
    } catch {
      /* A missing/broken approval channel must deny execution. */
    }
    return { block: true, reason: "Denied by RoamCli approval" };
  });
}
