import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { isAbsolute, normalize, resolve } from "node:path";
import {
  RunnerProfileSchema,
  type RunnerProfile,
} from "@roamcli/shared/protocol";

export interface RunnerCliOptions {
  server: string;
  token: string | undefined;
  profile: RunnerProfile;
  runnerId: string;
  workspace: string;
  dataDir: string;
  agentPlugins: string[];
}

export function parseCliArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): RunnerCliOptions {
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
    if (rawKey === "agent-plugin") {
      const current = values.get(rawKey);
      values.set(rawKey, current === undefined ? value : `${current},${value}`);
    } else {
      values.set(rawKey, value);
    }
  }

  const server = values.get("server") ?? env.ROAM_RUNNER_SERVER;
  if (server === undefined || server.length === 0) {
    throw new Error("Missing --server or ROAM_RUNNER_SERVER");
  }

  const profileValue =
    values.get("profile") ?? env.ROAM_RUNNER_PROFILE ?? "standard";
  const profile = RunnerProfileSchema.parse(profileValue);
  const workspace = resolve(
    values.get("workspace") ?? env.ROAM_RUNNER_WORKSPACE ?? process.cwd(),
  );
  const dataDir = parseDataDir(
    values.get("data-dir") ?? env.ROAM_RUNNER_DATA_DIR ?? ".roam-runner",
  );

  return {
    server: normalizeServerUrl(server),
    token: values.get("token") ?? env.ROAM_RUNNER_TOKEN,
    profile,
    runnerId:
      values.get("runner-id") ??
      env.ROAM_RUNNER_ID ??
      `${hostname()}-${randomUUID()}`,
    workspace,
    dataDir,
    agentPlugins: parsePluginList(
      values.get("agent-plugin") ?? env.ROAMCLI_AGENT_PLUGINS,
    ),
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
    "  --token       Runner token used during websocket registration.",
    "  --profile     Permission profile: strict, standard, trusted. Default: standard.",
    "  --runner-id   Stable runner id. Default: hostname plus UUID.",
    "  --workspace   Workspace root exposed to sessions. Default: cwd.",
    "  --data-dir    Relative runner state directory under workspace. Default: .roam-runner.",
    "  --agent-plugin Agent plugin package to load. Repeatable. Default: @roamcli/agent-codex.",
  ].join("\n");
}

function parseDataDir(value: string): string {
  if (value.trim().length === 0) {
    throw new Error("--data-dir cannot be empty");
  }
  if (value.startsWith("~") || isAbsolute(value)) {
    throw new Error("--data-dir must be relative to --workspace");
  }
  if (value.split(/[\\/]+/).some((segment) => segment === "..")) {
    throw new Error("--data-dir cannot contain .. path segments");
  }
  const normalized = normalize(value);
  if (normalized === ".") {
    throw new Error("--data-dir cannot resolve to the workspace root");
  }
  return normalized;
}

function parsePluginList(value: string | undefined): string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
