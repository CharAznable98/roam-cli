import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
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

type RawRunnerCliOptions = Partial<{
  server: string;
  token: string;
  profile: string;
  runnerId: string;
  workspace: string;
  dataDir: string;
  agentPlugins: string;
}>;

interface RunnerConfigFile {
  server?: string;
  token?: string;
  profile?: string;
  runnerId?: string;
  workspace?: string;
  dataDir?: string;
  agentPlugins?: string[];
}

const DEFAULT_DATA_DIR = ".roam-runner";
type ConfigValueSource = "cli" | "env" | "config" | "default";

export interface ResolvedRunnerConfig {
  options: RunnerCliOptions;
  configPath: string;
}

export function parseCliArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): RunnerCliOptions {
  const values = parseRawCliArgs(argv);
  return resolveOptions(values, env, undefined);
}

export async function resolveRunnerConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedRunnerConfig> {
  const cli = parseRawCliArgs(argv);
  const locator = resolveConfigLocator(cli, env);
  const fileConfig = await readRunnerConfigFile(locator.configPath);
  const options = resolveOptions(cli, env, fileConfig, locator.configPath);
  if (options.token === undefined || options.token.length === 0) {
    throw new Error(
      "Missing --token or ROAM_RUNNER_TOKEN or local config token",
    );
  }
  return {
    options,
    configPath: locator.configPath,
  };
}

export async function persistRunnerConfig(
  configPath: string,
  options: RunnerCliOptions,
): Promise<void> {
  const content = `${JSON.stringify(
    {
      server: options.server,
      token: options.token,
      profile: options.profile,
      runnerId: options.runnerId,
      workspace: options.workspace,
      dataDir: options.dataDir,
      agentPlugins: options.agentPlugins,
    },
    null,
    2,
  )}\n`;
  const effectiveConfigPath = join(
    options.workspace,
    options.dataDir,
    "config.json",
  );
  const discoverableConfigPath = join(
    options.workspace,
    DEFAULT_DATA_DIR,
    "config.json",
  );
  const configPaths = new Set([
    configPath,
    effectiveConfigPath,
    discoverableConfigPath,
  ]);

  for (const targetPath of configPaths) {
    await writeRunnerConfigFile(targetPath, content);
  }
}

async function writeRunnerConfigFile(
  configPath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, content, "utf8");
}

function parseRawCliArgs(argv: readonly string[]): RawRunnerCliOptions {
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

  const raw: RawRunnerCliOptions = {};
  setIfDefined(raw, "server", values.get("server"));
  setIfDefined(raw, "token", values.get("token"));
  setIfDefined(raw, "profile", values.get("profile"));
  setIfDefined(raw, "runnerId", values.get("runner-id"));
  setIfDefined(raw, "workspace", values.get("workspace"));
  setIfDefined(raw, "dataDir", values.get("data-dir"));
  setIfDefined(raw, "agentPlugins", values.get("agent-plugin"));
  return raw;
}

function resolveOptions(
  cli: RawRunnerCliOptions,
  env: NodeJS.ProcessEnv,
  fileConfig: RunnerConfigFile | undefined,
  configPath?: string,
): RunnerCliOptions {
  const serverSource = valueSource(
    cli.server,
    env.ROAM_RUNNER_SERVER,
    fileConfig?.server,
  );
  const server = cli.server ?? env.ROAM_RUNNER_SERVER ?? fileConfig?.server;
  if (server === undefined || server.length === 0) {
    throw new Error(
      "Missing --server or ROAM_RUNNER_SERVER or local config server",
    );
  }
  const normalizedServer = withConfigErrorContext(
    serverSource,
    configPath,
    () => normalizeServerUrl(server),
  );

  const profileValue =
    cli.profile ?? env.ROAM_RUNNER_PROFILE ?? fileConfig?.profile ?? "standard";
  const profile = withConfigErrorContext(
    valueSource(cli.profile, env.ROAM_RUNNER_PROFILE, fileConfig?.profile),
    configPath,
    () => RunnerProfileSchema.parse(profileValue),
  );
  const workspace = resolve(
    cli.workspace ??
      env.ROAM_RUNNER_WORKSPACE ??
      fileConfig?.workspace ??
      defaultWorkspace(env),
  );
  const dataDirValue =
    cli.dataDir ??
    env.ROAM_RUNNER_DATA_DIR ??
    fileConfig?.dataDir ??
    DEFAULT_DATA_DIR;
  const dataDir = withConfigErrorContext(
    valueSource(cli.dataDir, env.ROAM_RUNNER_DATA_DIR, fileConfig?.dataDir),
    configPath,
    () => parseDataDir(dataDirValue),
  );
  const token = cli.token ?? env.ROAM_RUNNER_TOKEN ?? fileConfig?.token;

  return {
    server: normalizedServer,
    token,
    profile,
    runnerId:
      cli.runnerId ??
      env.ROAM_RUNNER_ID ??
      fileConfig?.runnerId ??
      `${hostname()}-${randomUUID()}`,
    workspace,
    dataDir,
    agentPlugins: parsePluginList(
      cli.agentPlugins,
      env.ROAMCLI_AGENT_PLUGINS,
      fileConfig?.agentPlugins,
    ),
  };
}

function valueSource(
  cliValue: string | undefined,
  envValue: string | undefined,
  configValue: string | undefined,
): ConfigValueSource {
  if (cliValue !== undefined) {
    return "cli";
  }
  if (envValue !== undefined) {
    return "env";
  }
  if (configValue !== undefined) {
    return "config";
  }
  return "default";
}

function withConfigErrorContext<T>(
  source: ConfigValueSource,
  configPath: string | undefined,
  read: () => T,
): T {
  try {
    return read();
  } catch (error) {
    if (source === "config" && configPath !== undefined) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid runner config at ${configPath}: ${message}`);
    }
    throw error;
  }
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
    "Runner reads and writes local config at <workspace>/<data-dir>/config.json.",
    "CLI options and environment variables override local config and are persisted.",
    "",
    "Options:",
    "  --server      Server websocket URL. http/https are converted to ws/wss.",
    "  --token       Runner token used during websocket registration.",
    "  --profile     Permission profile: strict, standard, trusted. Default: standard.",
    "  --runner-id   Stable runner id. Default: hostname plus UUID.",
    "  --workspace   Workspace root exposed to sessions. Default: package invocation cwd or cwd.",
    "  --data-dir    Relative runner state directory under workspace. Default: .roam-runner.",
    "  --agent-plugin Agent plugin package to load. Repeatable. Default: built-in first-party agents.",
  ].join("\n");
}

function resolveConfigLocator(
  cli: RawRunnerCliOptions,
  env: NodeJS.ProcessEnv,
): { workspace: string; dataDir: string; configPath: string } {
  const workspace = resolve(
    cli.workspace ?? env.ROAM_RUNNER_WORKSPACE ?? defaultWorkspace(env),
  );
  const dataDir = parseDataDir(
    cli.dataDir ?? env.ROAM_RUNNER_DATA_DIR ?? DEFAULT_DATA_DIR,
  );
  return {
    workspace,
    dataDir,
    configPath: join(workspace, dataDir, "config.json"),
  };
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

function defaultWorkspace(env: NodeJS.ProcessEnv): string {
  return env.INIT_CWD && env.INIT_CWD.length > 0 ? env.INIT_CWD : process.cwd();
}

async function readRunnerConfigFile(
  configPath: string,
): Promise<RunnerConfigFile | undefined> {
  let content: string;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid runner config at ${configPath}: ${message}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid runner config at ${configPath}: expected object`);
  }

  const config = parsed as Record<string, unknown>;
  const result: RunnerConfigFile = {};
  for (const [key, value] of Object.entries(config)) {
    if (
      key === "server" ||
      key === "token" ||
      key === "profile" ||
      key === "runnerId" ||
      key === "workspace" ||
      key === "dataDir"
    ) {
      if (typeof value !== "string") {
        throw new Error(
          `Invalid runner config at ${configPath}: ${key} must be a string`,
        );
      }
      result[key] = value;
      continue;
    }
    if (key === "agentPlugins") {
      if (
        !Array.isArray(value) ||
        !value.every((item) => typeof item === "string")
      ) {
        throw new Error(
          `Invalid runner config at ${configPath}: agentPlugins must be an array of strings`,
        );
      }
      result.agentPlugins = value;
    }
  }
  return result;
}

function parsePluginList(
  cliValue: string | undefined,
  envValue: string | undefined,
  configValue: string[] | undefined,
): string[] {
  if (cliValue !== undefined) {
    return parsePluginListValue(cliValue);
  }
  if (envValue !== undefined) {
    return parsePluginListValue(envValue);
  }
  return configValue ?? [];
}

function parsePluginListValue(value: string): string[] {
  if (value.trim().length === 0) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function setIfDefined<K extends keyof RawRunnerCliOptions>(
  target: RawRunnerCliOptions,
  key: K,
  value: RawRunnerCliOptions[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
