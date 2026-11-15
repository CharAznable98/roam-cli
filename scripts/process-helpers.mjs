import { spawn, execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function terminateTestChild(child) {
  if (
    process.platform === "win32" &&
    child.pid &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    // Include agent descendants whose cwd would otherwise lock temporary worktrees.
    void promisify(execFile)(
      "taskkill.exe",
      ["/pid", String(child.pid), "/t", "/f"],
      { windowsHide: true },
    ).catch(() => {});
  } else {
    child.kill("SIGTERM");
  }
}
const packages = {
  "@roamcli/server": "apps/server",
  "@roamcli/runner": "apps/runner",
  "@roamcli/shared": "packages/shared",
  "@roamcli/agent-plugin-sdk": "packages/agent-plugin-sdk",
  "@roamcli/agent-codex": "packages/agent-codex",
  "@roamcli/agent-pi": "packages/agent-pi",
};

// Invoke Node tools directly: .cmd shims cannot be spawned without a shell on Windows,
// and killing a package-manager wrapper would leave its server/runner child alive.
export function spawnWorkspace(command, args, options) {
  if (command === "pnpm" && args[0] === "--filter" && packages[args[1]]) {
    const directory = resolve(root, packages[args[1]]);
    const require = createRequire(resolve(directory, "package.json"));
    let nodeArgs;
    if (args[2] === "build") {
      nodeArgs = [
        require.resolve("typescript/bin/tsc"),
        "-p",
        resolve(directory, "tsconfig.json"),
      ];
    } else if (args[2] === "dev" || (args[2] === "exec" && args[3] === "tsx")) {
      const remaining = args.slice(args[2] === "dev" ? 3 : 5);
      nodeArgs = [
        "--import",
        pathToFileURL(require.resolve("tsx")).href,
        resolve(directory, "src/index.ts"),
        ...remaining,
      ];
    } else {
      throw new Error(`Unsupported workspace test command: ${args.join(" ")}`);
    }
    return spawn(process.execPath, nodeArgs, { ...options, windowsHide: true });
  }
  return spawn(command, args, { ...options, windowsHide: true });
}

export async function launchTestBrowser(chromium, options = {}) {
  if (process.env.ROAMCLI_BROWSER_CHANNEL) {
    return chromium.launch({
      ...options,
      channel: process.env.ROAMCLI_BROWSER_CHANNEL,
    });
  }
  try {
    return await chromium.launch(options);
  } catch (originalError) {
    // A locally installed browser can run the same tests without an extra download.
    if (process.platform === "win32") {
      for (const channel of ["chrome", "msedge"]) {
        try {
          return await chromium.launch({ ...options, channel });
        } catch {}
      }
    }
    throw originalError;
  }
}
