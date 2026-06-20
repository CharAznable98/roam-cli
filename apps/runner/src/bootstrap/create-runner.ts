import { join } from "node:path";
import type { RunnerCommand } from "@roamcli/shared/protocol";
import { loadAgentRegistry } from "../agents/registry.js";
import { AuditLog } from "../persistence/audit.js";
import { EventCache } from "../persistence/cache.js";
import {
  SessionManager,
  type SessionManagerOptions,
} from "../sessions/manager.js";
import {
  RunnerConnection,
  type WebSocketFactory,
} from "../transport/connection.js";
import { parseCliArgs } from "./cli.js";
import { createRunnerRegistration, runnerStateDir } from "./registration.js";

export interface CreateRunnerOptions {
  createSocket?: WebSocketFactory;
}

export async function createRunner(
  argv: readonly string[],
  options: CreateRunnerOptions = {},
): Promise<RunnerConnection> {
  const cli = parseCliArgs(argv);
  const registry = await loadAgentRegistry(
    cli.profile,
    cli.agentPlugins.length > 0 ? cli.agentPlugins : undefined,
  );
  const registration = createRunnerRegistration({
    runnerId: cli.runnerId,
    workspace: cli.workspace,
    dataDir: cli.dataDir,
    profile: cli.profile,
    capabilities: registry.capabilities,
  });

  const stateDir = runnerStateDir(cli.workspace, cli.dataDir);
  const audit = new AuditLog(join(stateDir, "audit.jsonl"));
  const cache = new EventCache(join(stateDir, "pending-events.jsonl"));
  let connection: RunnerConnection;
  const sessionOptions: Omit<SessionManagerOptions, "approvalSecret"> = {
    workspace: cli.workspace,
    stateDir,
    profile: cli.profile,
    agents: registry.agents,
    emit: (event) => connection.send(event),
  };
  const sessions = new SessionManager(
    cli.token === undefined
      ? sessionOptions
      : { ...sessionOptions, approvalSecret: cli.token },
  );

  const connectionOptions = {
    serverUrl: cli.server,
    token: cli.token,
    registration,
    cache,
    audit,
    onCommand: (command: RunnerCommand) => sessions.handle(command),
  };
  connection = new RunnerConnection(
    options.createSocket === undefined
      ? connectionOptions
      : { ...connectionOptions, createSocket: options.createSocket },
  );
  return connection;
}
