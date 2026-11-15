import { existsSync, readFileSync, statSync } from "node:fs";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

export function piInvocation(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (/\.(?:mjs|cjs|js)$/i.test(command)) {
    return { command: process.execPath, args: [command] };
  }
  if (platform !== "win32" || /\.exe$/i.test(command)) {
    return { command, args: [] };
  }
  // Windows .cmd/.ps1 wrappers require a shell. Resolve their JS entry instead,
  // keeping paths and user input out of cmd.exe/PowerShell command strings.
  const path = Object.entries(env).find(
    ([key]) => key.toUpperCase() === "PATH",
  )?.[1];
  const directories =
    isAbsolute(command) || /[\\/]/.test(command)
      ? [dirname(resolve(command))]
      : (path ?? "")
          .split(platform === process.platform ? delimiter : ";")
          .filter(Boolean);
  const name = command.replace(/^.*[\\/]/, "").replace(/\.(?:cmd|ps1)$/i, "");
  for (const directory of directories) {
    if (existsSync(join(directory, `${name}.exe`))) {
      return { command: join(directory, `${name}.exe`), args: [] };
    }
    if (name !== "pi") continue;
    const managedEntry = managedPiEntry(directory);
    if (managedEntry)
      return { command: process.execPath, args: [managedEntry] };
    for (const scope of ["@earendil-works", "@mariozechner"]) {
      const root = join(directory, "node_modules", scope, "pi-coding-agent");
      try {
        const pkg = JSON.parse(
          readFileSync(join(root, "package.json"), "utf8"),
        ) as { bin?: string | { pi?: string } };
        const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
        if (bin && existsSync(resolve(root, bin))) {
          return { command: process.execPath, args: [resolve(root, bin)] };
        }
      } catch {
        /* This PATH entry is not an npm Pi installation. */
      }
    }
  }
  throw new Error(
    "Cannot find the Pi executable. Install @earendil-works/pi-coding-agent, or set ROAMCLI_AGENT_PI_COMMAND to its absolute .js or .exe entry path.",
  );
}

function managedPiEntry(directory: string): string | undefined {
  if (
    !existsSync(join(directory, "pi-launcher.js")) ||
    !["pi", "pi.cmd", "pi.ps1"].some((name) =>
      existsSync(join(directory, name)),
    )
  )
    return;
  try {
    // Follow the official installer's active release, but spawn its CLI directly:
    // the launcher uses spawnSync, leaving Pi behind if only its parent is killed.
    const installRoot = resolve(directory, "..", "install");
    const version = readFileSync(
      join(installRoot, "current-version"),
      "utf8",
    ).trim();
    if (
      !/^[0-9A-Za-z._+-]+$/.test(version) ||
      version === "." ||
      version === ".."
    )
      throw new Error("invalid current-version");
    const packageRoot = join(
      installRoot,
      "releases",
      version,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    const pkg = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { bin?: string | { pi?: string } };
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
    if (typeof bin !== "string" || !bin)
      throw new Error("package does not declare a pi executable");
    const cli = resolve(packageRoot, bin);
    const relativeCli = relative(packageRoot, cli);
    if (
      relativeCli.startsWith("..") ||
      isAbsolute(relativeCli) ||
      !statSync(cli).isFile()
    )
      throw new Error("invalid package executable");
    return cli;
  } catch (error) {
    throw new Error(
      `Cannot resolve the managed Pi installation at ${directory}: ${error instanceof Error ? error.message : String(error)}. Repair it with the Pi installer.`,
    );
  }
}
