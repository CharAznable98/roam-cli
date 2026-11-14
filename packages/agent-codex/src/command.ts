import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";

/** Explicit JavaScript launchers are useful for portable wrappers and test agents. */
export function spawnCodexCommand(
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams {
  const nodeScript = /\.(?:mjs|cjs|js)$/i.test(command);
  return spawn(
    nodeScript ? process.execPath : command,
    nodeScript ? [command, ...args] : [...args],
    {
      ...options,
      windowsHide: true,
      stdio: "pipe",
    },
  );
}
