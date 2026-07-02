import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const REEXEC_ENV = "ROAMCLI_RUNNER_REEXEC";
const RUNNER_PACKAGE = "@roamcli/runner";
const OFFICIAL_AGENT_PACKAGES = new Set([
  "@roamcli/agent-codex",
  "@roamcli/agent-claude-code",
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
  return ["--yes", ...packageArgs, "--", "roam-runner", ...input.runnerArgs];
}

export function hasAlreadyReexeced(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[REEXEC_ENV] === "1";
}

export async function reexecRunnerWithNpx(input: {
  agentPlugins: readonly string[];
  runnerArgs: readonly string[];
  env?: NodeJS.ProcessEnv;
}): Promise<never> {
  const env = input.env ?? process.env;
  const child = spawn("npx", buildNpxRunnerArgs(input), {
    env: { ...env, [REEXEC_ENV]: "1" },
    stdio: "inherit",
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
