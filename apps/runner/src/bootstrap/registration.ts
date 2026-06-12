import { generateKeyPairSync } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import type { RunnerCapability, RunnerProfile, RunnerRegistration } from "@roamcli/shared/protocol";

export interface RunnerRegistrationOptions {
  runnerId: string;
  workspace: string;
  profile: RunnerProfile;
  capabilities: RunnerCapability[];
}

export function createRunnerRegistration(options: RunnerRegistrationOptions): RunnerRegistration {
  return {
    runnerId: options.runnerId,
    displayName: `Runner ${options.runnerId}`,
    hostname: hostname(),
    workspaceRoot: options.workspace,
    profile: options.profile,
    publicKey: createPublicKey(),
    capabilities: options.capabilities,
    version: "1.1.0"
  };
}

export function runnerStateDir(workspace: string): string {
  return join(workspace, ".roam-runner");
}

function createPublicKey(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  return publicKey.export({ format: "pem", type: "spki" }).toString();
}
