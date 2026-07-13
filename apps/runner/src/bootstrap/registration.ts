import { generateKeyPairSync } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import type {
  RunnerCapability,
  RunnerProfile,
  RunnerRegistration,
} from "@roamcli/shared/protocol";

export interface RunnerRegistrationOptions {
  runnerId: string;
  workspace: string;
  dataDir: string;
  profile: RunnerProfile;
  capabilities: RunnerCapability[];
}

export function createRunnerRegistration(
  options: RunnerRegistrationOptions,
): RunnerRegistration {
  return {
    runnerId: options.runnerId,
    displayName: `Runner ${options.runnerId}`,
    hostname: hostname(),
    workspaceRoot: options.workspace,
    dataDir: options.dataDir,
    profile: options.profile,
    // Servers released before approvalSignatureMode was introduced require
    // this field during registration. It is retained only for rolling
    // compatibility; the explicit mode below makes clear that approval
    // decisions are not signed with the corresponding private key.
    publicKey: createLegacyRegistrationPublicKey(),
    approvalSignatureMode: "unsupported",
    capabilities: options.capabilities,
    version: "1.1.0",
  };
}

function createLegacyRegistrationPublicKey(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  return publicKey.export({ format: "pem", type: "spki" }).toString();
}

export function runnerStateDir(
  workspace: string,
  dataDir = ".roam-runner",
): string {
  return join(workspace, dataDir);
}
