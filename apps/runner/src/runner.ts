import { generateKeyPairSync } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import type { RunnerCommand, RunnerRegistration } from "@roamcli/protocol";
import { parseCliArgs } from "./cli.js";
import { AuditLog } from "./audit.js";
import { EventCache } from "./cache.js";
import { buildCapabilities } from "./capabilities.js";
import { RunnerConnection, type WebSocketFactory } from "./connection.js";
import { SessionManager, type SessionManagerOptions } from "./session.js";

export interface CreateRunnerOptions {
  createSocket?: WebSocketFactory;
}

export async function createRunner(argv: readonly string[], options: CreateRunnerOptions = {}): Promise<RunnerConnection> {
  const cli = parseCliArgs(argv);
  const capabilities = buildCapabilities(cli.profile);
  const publicKey = createPublicKey();
  const registration: RunnerRegistration = {
    runnerId: cli.runnerId,
    displayName: `Runner ${cli.runnerId}`,
    hostname: hostname(),
    workspaceRoot: cli.workspace,
    profile: cli.profile,
    publicKey,
    capabilities,
    version: "0.1.0"
  };

  const stateDir = join(cli.workspace, ".roam-runner");
  const audit = new AuditLog(join(stateDir, "audit.jsonl"));
  const cache = new EventCache(join(stateDir, "pending-events.jsonl"));
  let connection: RunnerConnection;
  const sessionOptions: Omit<SessionManagerOptions, "approvalSecret"> = {
    workspace: cli.workspace,
    capabilities,
    emit: (event) => connection.send(event)
  };
  const sessions = new SessionManager(
    cli.token === undefined ? sessionOptions : { ...sessionOptions, approvalSecret: cli.token }
  );

  const connectionOptions = {
    serverUrl: cli.server,
    token: cli.token,
    registration,
    cache,
    audit,
    onCommand: (command: RunnerCommand) => sessions.handle(command)
  };
  connection = new RunnerConnection(
    options.createSocket === undefined ? connectionOptions : { ...connectionOptions, createSocket: options.createSocket }
  );
  return connection;
}

function createPublicKey(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  return publicKey.export({ format: "pem", type: "spki" }).toString();
}
