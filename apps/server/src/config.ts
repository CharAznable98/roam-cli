import fs from "node:fs";
import path from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  publicOrigin?: string;
  resetOwner: boolean;
  webDistDir?: string;
  runnerRpcTimeoutMs: number;
}

export interface ServerConfigInput {
  host?: string;
  port?: number;
  dataDir?: string;
  publicOrigin?: string;
  resetOwner?: boolean;
  webDistDir?: string | false;
  runnerRpcTimeoutMs?: number;
}

export function loadConfig(input: ServerConfigInput = {}): ServerConfig {
  const dataDir =
    input.dataDir ??
    process.env.ROAMCLI_DATA_DIR ??
    path.resolve(process.cwd(), ".roamcli-server");
  const configuredWebDist = input.webDistDir ?? process.env.ROAMCLI_WEB_DIST;
  const defaultWebDist = firstExistingDirectory([
    path.resolve(process.cwd(), "apps/web/dist"),
    path.resolve(process.cwd(), "../web/dist"),
  ]);
  const webDistDir =
    configuredWebDist === false
      ? undefined
      : (configuredWebDist ?? defaultWebDist);
  const publicOrigin = input.publicOrigin ?? process.env.ROAMCLI_PUBLIC_ORIGIN;
  return {
    host: input.host ?? process.env.HOST ?? "127.0.0.1",
    port: input.port ?? Number(process.env.PORT ?? 3000),
    dataDir,
    resetOwner:
      input.resetOwner ??
      ["1", "true", "yes"].includes(
        (process.env.ROAMCLI_RESET_OWNER ?? "").toLowerCase(),
      ),
    ...(publicOrigin ? { publicOrigin } : {}),
    runnerRpcTimeoutMs:
      input.runnerRpcTimeoutMs ??
      Number(process.env.ROAMCLI_RUNNER_RPC_TIMEOUT_MS ?? 5000),
    ...(webDistDir ? { webDistDir } : {}),
  };
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function firstExistingDirectory(candidates: string[]): string | undefined {
  return candidates.find(isDirectory);
}
