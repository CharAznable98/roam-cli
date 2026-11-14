import { setPrivateMode, renameWithRetry } from "../platform/filesystem.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import {
  basename,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
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

export interface RunnerConfigDraft {
  server?: string;
  token?: string;
  profile: RunnerProfile;
  runnerId?: string;
  workspace: string;
  dataDir: string;
  agentPlugins: string[];
}

export interface ResolvedRunnerConfigDraft {
  options: RunnerConfigDraft;
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
  const locator = await resolveConfigLocator(cli, env);
  const fileConfig = await readRunnerConfigFile(locator.configPath);
  const workspace = await resolveEffectiveWorkspace(cli, env, fileConfig);
  const options = resolveOptions(
    cli,
    env,
    fileConfig,
    locator.configPath,
    workspace,
  );
  await resolveRunnerDataDir(options.workspace, options.dataDir, false);
  if (options.token === undefined || options.token.length === 0) {
    throw new Error(
      "Missing --token or ROAM_RUNNER_TOKEN (legacy local config tokens are read only for migration)",
    );
  }
  if (options.agentPlugins.length === 0) {
    throw new Error(
      "Missing --agent-plugin or ROAMCLI_AGENT_PLUGINS or local config agentPlugins",
    );
  }
  return {
    options,
    configPath: await resolveConfigPath(workspace, locator.dataDir),
  };
}

export async function resolveRunnerConfigDraft(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedRunnerConfigDraft> {
  const cli = parseRawCliArgs(argv);
  const locator = await resolveConfigLocator(cli, env);
  const fileConfig = await readRunnerConfigFile(locator.configPath);
  const workspace = await resolveEffectiveWorkspace(cli, env, fileConfig);
  const server = cli.server ?? env.ROAM_RUNNER_SERVER ?? fileConfig?.server;
  const profileValue =
    cli.profile ?? env.ROAM_RUNNER_PROFILE ?? fileConfig?.profile ?? "standard";
  const dataDirValue =
    cli.dataDir ??
    env.ROAM_RUNNER_DATA_DIR ??
    fileConfig?.dataDir ??
    DEFAULT_DATA_DIR;
  const draft: RunnerConfigDraft = {
    profile: withConfigErrorContext(
      valueSource(cli.profile, env.ROAM_RUNNER_PROFILE, fileConfig?.profile),
      locator.configPath,
      () => RunnerProfileSchema.parse(profileValue),
    ),
    workspace,
    dataDir: withConfigErrorContext(
      valueSource(cli.dataDir, env.ROAM_RUNNER_DATA_DIR, fileConfig?.dataDir),
      locator.configPath,
      () => parseDataDir(dataDirValue),
    ),
    agentPlugins: parsePluginList(
      cli.agentPlugins,
      env.ROAMCLI_AGENT_PLUGINS,
      fileConfig?.agentPlugins,
    ),
  };
  if (server !== undefined && server.length > 0) {
    draft.server = withConfigErrorContext(
      valueSource(cli.server, env.ROAM_RUNNER_SERVER, fileConfig?.server),
      locator.configPath,
      () => normalizeServerUrl(server),
    );
  }
  const token = cli.token ?? env.ROAM_RUNNER_TOKEN ?? fileConfig?.token;
  if (token !== undefined) {
    draft.token = token;
  }
  const runnerId = cli.runnerId ?? env.ROAM_RUNNER_ID ?? fileConfig?.runnerId;
  if (runnerId !== undefined) {
    draft.runnerId = runnerId;
  }
  await resolveRunnerDataDir(draft.workspace, draft.dataDir, false);
  return {
    options: draft,
    configPath: await resolveConfigPath(workspace, locator.dataDir),
  };
}

export async function persistRunnerConfig(
  configPath: string,
  options: RunnerCliOptions,
): Promise<void> {
  const content = `${JSON.stringify(
    {
      server: options.server,
      profile: options.profile,
      runnerId: options.runnerId,
      workspace: options.workspace,
      dataDir: options.dataDir,
      agentPlugins: options.agentPlugins,
    },
    null,
    2,
  )}\n`;
  const workspace = await resolveCanonicalWorkspace(options.workspace);
  const dataDirs = [...new Set([options.dataDir, DEFAULT_DATA_DIR])];
  const targets = await Promise.all(
    dataDirs.map(async (dataDir) => {
      const directory = await resolveRunnerDataDir(workspace, dataDir, true);
      const path = join(directory, "config.json");
      await assertSafeConfigFile(path);
      return { directory, path };
    }),
  );
  const expectedConfigPaths = new Set(targets.map((target) => target.path));
  if (!expectedConfigPaths.has(resolve(configPath))) {
    throw new Error(
      `Runner config path must use the selected workspace and data directory: ${configPath}`,
    );
  }

  for (const target of targets) {
    await writeRunnerConfigFile(target, content);
  }
}

async function writeRunnerConfigFile(
  target: { directory: string; path: string },
  content: string,
): Promise<void> {
  const temporaryPath = join(
    target.directory,
    `.${basename(target.path)}.tmp-${process.pid}-${randomUUID()}`,
  );
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporaryPath, "wx", 0o600);
    await file.writeFile(content, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await renameWithRetry(temporaryPath, target.path);
    await hardenConfigFile(target.path);
  } catch (error) {
    await file?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function resolveRunnerDataDir(
  workspace: string,
  dataDir: string,
  create: boolean,
): Promise<string> {
  const canonicalWorkspace = await resolveCanonicalWorkspace(workspace);
  const candidate = resolve(canonicalWorkspace, parseDataDir(dataDir));
  if (!isInside(canonicalWorkspace, candidate)) {
    throw new Error("--data-dir must stay inside the canonical workspace");
  }

  const relativePath = relative(canonicalWorkspace, candidate);
  let current = canonicalWorkspace;
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = join(current, segment);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
      if (!create) {
        return candidate;
      }
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (!isNodeError(mkdirError) || mkdirError.code !== "EEXIST") {
          throw mkdirError;
        }
      }
      info = await lstat(current);
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Runner data path cannot contain symlinks: ${current}`);
    }
    if (!info.isDirectory()) {
      throw new Error(
        `Runner data path component is not a directory: ${current}`,
      );
    }
    const canonicalCurrent = await realpath(current);
    if (
      canonicalCurrent !== current ||
      !isInside(canonicalWorkspace, canonicalCurrent)
    ) {
      throw new Error(`Runner data path escapes workspace: ${current}`);
    }
  }
  await hardenRunnerDataDirectory(candidate);
  return candidate;
}

function parseRawCliArgs(argv: readonly string[]): RawRunnerCliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined || arg === "--") {
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
  canonicalWorkspace?: string,
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
  const workspace =
    canonicalWorkspace ??
    resolve(
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
  if (url.protocol === "ws:" && !isLoopbackHostname(url.hostname)) {
    throw new Error(
      "Plaintext runner connections are limited to loopback hosts; use wss:// for remote servers",
    );
  }
  return url.toString();
}

function isLoopbackHostname(hostnameValue: string): boolean {
  const hostname = hostnameValue.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

function helpText(): string {
  return [
    "Usage: roam-runner --server <wss-url> [options]",
    "",
    "Runner reads and writes local config at <workspace>/<data-dir>/config.json.",
    "CLI options and environment variables override local config. Runner tokens are never persisted.",
    "",
    "Options:",
    "  --server      Server websocket URL. Remote servers require wss; ws is loopback-only.",
    "  --token       Runner token used during websocket registration. Prefer ROAM_RUNNER_TOKEN.",
    "  --profile     Permission profile: strict, standard, trusted. Default: standard.",
    "  --runner-id   Stable runner id. Default: hostname plus UUID.",
    "  --workspace   Workspace root exposed to sessions. Default: package invocation cwd or cwd.",
    "  --data-dir    Relative runner state directory under workspace. Default: .roam-runner.",
    "  --agent-plugin Agent plugin package to load. Repeatable. Required.",
  ].join("\n");
}

async function resolveConfigLocator(
  cli: RawRunnerCliOptions,
  env: NodeJS.ProcessEnv,
): Promise<{ workspace: string; dataDir: string; configPath: string }> {
  const workspace = await resolveCanonicalWorkspace(
    cli.workspace ?? env.ROAM_RUNNER_WORKSPACE ?? defaultWorkspace(env),
  );
  const dataDir = parseDataDir(
    cli.dataDir ?? env.ROAM_RUNNER_DATA_DIR ?? DEFAULT_DATA_DIR,
  );
  const directory = await resolveRunnerDataDir(workspace, dataDir, false);
  return {
    workspace,
    dataDir,
    configPath: join(directory, "config.json"),
  };
}

async function resolveEffectiveWorkspace(
  cli: RawRunnerCliOptions,
  env: NodeJS.ProcessEnv,
  fileConfig: RunnerConfigFile | undefined,
): Promise<string> {
  return resolveCanonicalWorkspace(
    cli.workspace ??
      env.ROAM_RUNNER_WORKSPACE ??
      fileConfig?.workspace ??
      defaultWorkspace(env),
  );
}

async function resolveConfigPath(
  workspace: string,
  locatorDataDir: string,
): Promise<string> {
  const directory = await resolveRunnerDataDir(
    workspace,
    locatorDataDir,
    false,
  );
  return join(directory, "config.json");
}

async function resolveCanonicalWorkspace(path: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  const info = await stat(canonical);
  if (!info.isDirectory()) {
    throw new Error(`Runner workspace is not a directory: ${path}`);
  }
  return canonical;
}

async function assertSafeConfigFile(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(`Runner config path cannot be a symlink: ${path}`);
    }
    if (!info.isFile()) {
      throw new Error(`Runner config path is not a regular file: ${path}`);
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function hardenConfigFile(path: string): Promise<void> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile()) {
      throw new Error(`Runner config path is not a regular file: ${path}`);
    }
    await setPrivateMode(file, path, 0o600);
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function hardenRunnerDataDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const info = await directory.stat();
    if (!info.isDirectory()) {
      throw new Error(`Runner data path component is not a directory: ${path}`);
    }
    await setPrivateMode(directory, path, 0o700);
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
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
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const info = await lstat(configPath);
    if (info.isSymbolicLink()) {
      throw new Error(`Runner config path cannot be a symlink: ${configPath}`);
    }
    if (!info.isFile()) {
      throw new Error(
        `Runner config path is not a regular file: ${configPath}`,
      );
    }
    file = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedInfo = await file.stat();
    if (!openedInfo.isFile()) {
      throw new Error(
        `Runner config path is not a regular file: ${configPath}`,
      );
    }
    await setPrivateMode(file, configPath, 0o600);
    content = await file.readFile("utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  } finally {
    await file?.close().catch(() => undefined);
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
