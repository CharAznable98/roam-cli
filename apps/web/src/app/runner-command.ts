import type { InstallMetadata } from "@roamcli/shared/protocol";

export const fallbackInstallMetadata: InstallMetadata = {
  runnerPackageName: "@roamcli/runner",
  officialAgentPlugins: [],
};

export function buildRunnerCommand(
  token: string,
  install: InstallMetadata = fallbackInstallMetadata,
  agentPlugins: readonly string[] = [],
  location: Pick<Location, "host" | "protocol"> = window.location,
): string {
  const host = location.host || "127.0.0.1:8787";
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const serverUrl = `${protocol}//${host}/v1/runner`;
  const pluginPackageSpecs = new Map(
    install.officialAgentPlugins.map((plugin) => [
      plugin.packageName,
      plugin.packageSpec ?? plugin.packageName,
    ]),
  );
  const packageArgs = [
    install.runnerPackageSpec ?? install.runnerPackageName,
    ...agentPlugins.map(
      (packageName) => pluginPackageSpecs.get(packageName) ?? packageName,
    ),
  ]
    .map((packageName) => `  --package ${shellQuote(packageName)} \\`)
    .join("\n");
  const pluginArgs = agentPlugins
    .map((packageName) => `  --agent-plugin ${shellQuote(packageName)}`)
    .join(" \\\n");
  const baseCommand = [
    "npx --yes \\",
    packageArgs,
    "  -- roam-runner \\",
    `  --server ${shellQuote(serverUrl)} \\`,
    `  --token ${shellQuote(token)}`,
  ];
  if (pluginArgs.length === 0) {
    return baseCommand.join("\n");
  }
  return `${baseCommand.join("\n")} \\\n${pluginArgs}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
