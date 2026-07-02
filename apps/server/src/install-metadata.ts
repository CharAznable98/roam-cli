import { readFileSync } from "node:fs";
import type { InstallMetadata } from "@roamcli/shared/protocol";

const packageVersion = readPackageVersion();

export const installMetadata: InstallMetadata = {
  runnerPackageName: "@roamcli/runner",
  runnerPackageSpec: `@roamcli/runner@${packageVersion}`,
  officialAgentPlugins: [
    {
      packageName: "@roamcli/agent-codex",
      packageSpec: `@roamcli/agent-codex@${packageVersion}`,
      label: "Codex",
      description: "Runs sessions through the Codex app-server agent.",
    },
    {
      packageName: "@roamcli/agent-claude-code",
      packageSpec: `@roamcli/agent-claude-code@${packageVersion}`,
      label: "Claude Code",
      description: "Runs sessions through the Claude Code agent.",
    },
  ],
};

function readPackageVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // The package file is present in normal source and dist layouts.
  }
  return "latest";
}
