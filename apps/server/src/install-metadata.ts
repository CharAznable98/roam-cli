import type { InstallMetadata } from "@roamcli/shared/protocol";

export const installMetadata: InstallMetadata = {
  runnerPackageName: "@roamcli/runner",
  officialAgentPlugins: [
    {
      packageName: "@roamcli/agent-codex",
      label: "Codex",
      description: "Runs sessions through the Codex app-server agent.",
    },
    {
      packageName: "@roamcli/agent-claude-code",
      label: "Claude Code",
      description: "Runs sessions through the Claude Code agent.",
    },
  ],
};
