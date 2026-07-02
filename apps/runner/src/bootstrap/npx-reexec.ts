import { spawn } from "node:child_process";

const REEXEC_ENV = "ROAMCLI_RUNNER_REEXEC";
const RUNNER_PACKAGE = "@roamcli/runner";

export function buildNpxRunnerArgs(input: {
  agentPlugins: readonly string[];
  runnerArgs: readonly string[];
}): string[] {
  const packageArgs = [RUNNER_PACKAGE, ...input.agentPlugins].flatMap(
    (packageName) => ["--package", packageName],
  );
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
