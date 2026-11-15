import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { dirname, join } from "node:path";

const REEXEC_ENV = "ROAMCLI_RUNNER_REEXEC";
const RUNNER_PACKAGE = "@roamcli/runner";
const OFFICIAL_AGENT_PACKAGES = new Set([
  "@roamcli/agent-codex",
  "@roamcli/agent-claude-code",
  "@roamcli/agent-pi",
]);
const PACKAGE_VERSION = readPackageVersion();

export function buildNpxRunnerArgs(input: {
  agentPlugins: readonly string[];
  runnerArgs: readonly string[];
}): string[] {
  const packageArgs = [
    `${RUNNER_PACKAGE}@${PACKAGE_VERSION}`,
    ...input.agentPlugins.map(packageSpecForAgentPlugin),
  ].flatMap((packageName) => ["--package", packageName]);
  return [
    "--yes",
    ...packageArgs,
    "--",
    "roam-runner",
    ...withoutRunnerToken(input.runnerArgs).args,
  ];
}

export function buildNpxRunnerInvocation(input: {
  agentPlugins: readonly string[];
  runnerArgs: readonly string[];
  token?: string;
  env: NodeJS.ProcessEnv;
}): { args: string[]; env: NodeJS.ProcessEnv } {
  const scrubbed = withoutRunnerToken(input.runnerArgs);
  const token = input.token ?? scrubbed.token ?? input.env.ROAM_RUNNER_TOKEN;
  return {
    args: buildNpxRunnerArgs({
      agentPlugins: input.agentPlugins,
      runnerArgs: scrubbed.args,
    }),
    env: {
      ...input.env,
      [REEXEC_ENV]: "1",
      ...(token === undefined ? {} : { ROAM_RUNNER_TOKEN: token }),
    },
  };
}

export function hasAlreadyReexeced(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[REEXEC_ENV] === "1";
}

export function npxLauncher(
  args: string[],
  env: NodeJS.ProcessEnv,
): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command: "npx", args };
  // Run npm's JS entry directly rather than passing user arguments through cmd.exe.
  const candidates = [
    ...(env.npm_execpath
      ? [join(dirname(env.npm_execpath), "npx-cli.js")]
      : []),
    join(dirname(process.execPath), "node_modules/npm/bin/npx-cli.js"),
  ];
  const cli = candidates.find((path) => existsSync(path));
  if (!cli)
    throw new Error(
      "Cannot find npx-cli.js. Install Node.js with npm before starting the runner wizard.",
    );
  return { command: process.execPath, args: [cli, ...args] };
}

export async function reexecRunnerWithNpx(input: {
  agentPlugins: readonly string[];
  runnerArgs: readonly string[];
  token?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<never> {
  const env = input.env ?? process.env;
  const invocation = buildNpxRunnerInvocation({ ...input, env });
  const launcher = npxLauncher(invocation.args, env);
  const child = spawn(launcher.command, launcher.args, {
    env: invocation.env,
    stdio: "inherit",
    windowsHide: true,
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 0);
    });
  });
  process.exit(exitCode);
}

function withoutRunnerToken(args: readonly string[]): {
  args: string[];
  token?: string;
} {
  const safeArgs: string[] = [];
  let token: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--token") {
      token = args[index + 1] ?? token;
      index += 1;
      continue;
    }
    if (arg?.startsWith("--token=")) {
      token = arg.slice("--token=".length);
      continue;
    }
    if (arg !== undefined) {
      safeArgs.push(arg);
    }
  }
  return token === undefined ? { args: safeArgs } : { args: safeArgs, token };
}

export function isPluginLoadFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("Failed to load agent plugin ")
  );
}

function packageSpecForAgentPlugin(packageName: string): string {
  if (OFFICIAL_AGENT_PACKAGES.has(packageName)) {
    return `${packageName}@${PACKAGE_VERSION}`;
  }
  return packageName;
}

function readPackageVersion(): string {
  try {
    const raw = readFileSync(
      new URL("../../package.json", import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Source and published package layouts both keep package.json two levels up.
  }
  return "latest";
}
