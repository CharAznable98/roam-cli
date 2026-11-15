// Loaded by the user's Pi runtime. Structural types avoid bundling a second Pi
// SDK/version in the Runner; the extension only uses the public extension API.
interface PiContext {
  sessionManager: { getHeader(): unknown; getEntries(): readonly unknown[] };
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
    event: "session_start",
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
  if (token)
    pi.registerCommand(`roamcli-state-${token}`, {
      description: "Persist the RoamCli-managed session",
      handler: async (_args, ctx) => {
        ctx.ui.notify(
          `roamcli-snapshot:${token}:${JSON.stringify({ header: ctx.sessionManager.getHeader(), entries: ctx.sessionManager.getEntries() })}`,
          "info",
        );
      },
    });
  pi.on("session_start", (_event, ctx) => {
    if (token) ctx.ui.notify(`roamcli-ready:${token}`, "info");
  });
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
