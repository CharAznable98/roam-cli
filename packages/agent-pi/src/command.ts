import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";

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
  // npm's .cmd/.ps1 wrappers require a shell. Resolve their JS entry instead,
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
