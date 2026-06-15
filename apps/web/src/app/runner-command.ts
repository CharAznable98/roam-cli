export function buildRunnerCommand(
  token: string,
  location: Pick<Location, "host" | "protocol"> = window.location,
): string {
  const host = location.host || "127.0.0.1:8787";
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const serverUrl = `${protocol}//${host}/v1/runner`;
  return `pnpm --filter @roamcli/runner dev --server ${shellQuote(serverUrl)} --token ${shellQuote(token || "dev-token")}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
