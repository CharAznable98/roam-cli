import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { RunnerProfileSchema, type RunnerProfile } from "@roamcli/protocol";

export interface RunnerCliOptions {
  server: string;
  token: string | undefined;
  profile: RunnerProfile;
  runnerId: string;
  workspace: string;
}

export function parseCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): RunnerCliOptions {
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new CliHelp(helpText());
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (rawKey === undefined || rawKey.length === 0) {
      throw new Error(`Invalid option: ${arg}`);
    }
    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawKey}`);
    }
    if (inlineValue === undefined) {
      index += 1;
    }
    values.set(rawKey, value);
  }

  const server = values.get("server") ?? env.ROAM_RUNNER_SERVER;
  if (server === undefined || server.length === 0) {
    throw new Error("Missing --server or ROAM_RUNNER_SERVER");
  }

  const profileValue = values.get("profile") ?? env.ROAM_RUNNER_PROFILE ?? "standard";
  const profile = RunnerProfileSchema.parse(profileValue);
  const workspace = resolve(values.get("workspace") ?? env.ROAM_RUNNER_WORKSPACE ?? process.cwd());

  return {
    server: normalizeServerUrl(server),
    token: values.get("token") ?? env.ROAM_RUNNER_TOKEN,
    profile,
    runnerId: values.get("runner-id") ?? env.ROAM_RUNNER_ID ?? `${hostname()}-${randomUUID()}`,
    workspace
  };
}

export class CliHelp extends Error {
  public constructor(text: string) {
    super(text);
    this.name = "CliHelp";
  }
}

function normalizeServerUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("--server must use ws, wss, http, or https");
  }
  return url.toString();
}

function helpText(): string {
  return [
    "Usage: roam-runner --server <wss-url> [options]",
    "",
    "Options:",
    "  --server      Server websocket URL. http/https are converted to ws/wss.",
    "  --token       Bearer token used during websocket registration.",
    "  --profile     Permission profile: strict, standard, trusted. Default: standard.",
    "  --runner-id   Stable runner id. Default: hostname plus UUID.",
    "  --workspace   Workspace root exposed to sessions. Default: cwd."
  ].join("\n");
}
