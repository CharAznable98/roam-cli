import type { RunnerProfile } from "@roamcli/shared/protocol";

export interface PermissionTemplate {
  profile: RunnerProfile;
  allowShell: boolean;
  allowApplyPatch: boolean;
  requireApprovalForShell: boolean;
  requireApprovalForApplyPatch: boolean;
  allowedEnv: readonly string[];
  /**
   * Command execution is enforced by the selected agent runtime. These values
   * are display/documentation hints, not a runner security boundary.
   */
  commandPolicyEnforcement: "agent";
  advisoryBlockedCommands: readonly string[];
}

export const PERMISSION_TEMPLATES: Record<RunnerProfile, PermissionTemplate> = {
  strict: {
    profile: "strict",
    allowShell: true,
    allowApplyPatch: true,
    requireApprovalForShell: true,
    requireApprovalForApplyPatch: true,
    allowedEnv: ["PATH", "HOME", "SHELL", "TERM"],
    commandPolicyEnforcement: "agent",
    advisoryBlockedCommands: [
      "rm -rf",
      "git reset --hard",
      "git checkout --",
      "sudo",
    ],
  },
  standard: {
    profile: "standard",
    allowShell: true,
    allowApplyPatch: true,
    requireApprovalForShell: true,
    requireApprovalForApplyPatch: false,
    allowedEnv: ["PATH", "HOME", "SHELL", "TERM", "TMPDIR", "USER"],
    commandPolicyEnforcement: "agent",
    advisoryBlockedCommands: ["rm -rf /", "git reset --hard", "sudo"],
  },
  trusted: {
    profile: "trusted",
    allowShell: true,
    allowApplyPatch: true,
    requireApprovalForShell: false,
    requireApprovalForApplyPatch: false,
    allowedEnv: ["*"],
    commandPolicyEnforcement: "agent",
    advisoryBlockedCommands: [],
  },
};

const RUNNER_PRIVATE_ENV = new Set(["ROAM_RUNNER_TOKEN"]);

const WINDOWS_RUNTIME_ENV = new Set([
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SYSTEMROOT",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "HOMEDRIVE",
  "HOMEPATH",
  "CODEX_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
]);

export function getPermissionTemplate(
  profile: RunnerProfile,
): PermissionTemplate {
  switch (profile) {
    case "strict":
      return PERMISSION_TEMPLATES.strict;
    case "standard":
      return PERMISSION_TEMPLATES.standard;
    case "trusted":
      return PERMISSION_TEMPLATES.trusted;
  }
}

/**
 * Builds the environment passed to plugin callbacks and their child processes.
 * Restricted profiles receive only their explicit allowlist. Trusted agents
 * inherit the host environment, except runner-owned credentials which are
 * never required by an agent. Plugin modules execute in-process, so this is
 * context hygiene rather than an isolation boundary for untrusted code.
 */
export function sanitizeAgentEnvironment(
  profile: RunnerProfile,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const template = getPermissionTemplate(profile);
  const allowAll = template.allowedEnv.includes("*");
  const allowed = new Set(template.allowedEnv);
  const result: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(env)) {
    const normalizedKey = key.toUpperCase();
    if (
      value !== undefined &&
      !RUNNER_PRIVATE_ENV.has(normalizedKey) &&
      (allowAll ||
        allowed.has(normalizedKey) ||
        (process.platform === "win32" &&
          WINDOWS_RUNTIME_ENV.has(normalizedKey)))
    ) {
      result[key] = value;
    }
  }
  return result;
}
