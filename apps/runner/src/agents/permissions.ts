import type { RunnerProfile } from "@roamcli/shared/protocol";

export interface PermissionTemplate {
  profile: RunnerProfile;
  allowShell: boolean;
  allowApplyPatch: boolean;
  requireApprovalForShell: boolean;
  requireApprovalForApplyPatch: boolean;
  allowedEnv: readonly string[];
  blockedCommands: readonly string[];
}

export const PERMISSION_TEMPLATES: Record<RunnerProfile, PermissionTemplate> = {
  strict: {
    profile: "strict",
    allowShell: true,
    allowApplyPatch: true,
    requireApprovalForShell: true,
    requireApprovalForApplyPatch: true,
    allowedEnv: ["PATH", "HOME", "SHELL", "TERM"],
    blockedCommands: ["rm -rf", "git reset --hard", "git checkout --", "sudo"]
  },
  standard: {
    profile: "standard",
    allowShell: true,
    allowApplyPatch: true,
    requireApprovalForShell: true,
    requireApprovalForApplyPatch: false,
    allowedEnv: ["PATH", "HOME", "SHELL", "TERM", "TMPDIR", "USER"],
    blockedCommands: ["rm -rf /", "git reset --hard", "sudo"]
  },
  trusted: {
    profile: "trusted",
    allowShell: true,
    allowApplyPatch: true,
    requireApprovalForShell: false,
    requireApprovalForApplyPatch: false,
    allowedEnv: ["*"],
    blockedCommands: []
  }
};

export function getPermissionTemplate(profile: RunnerProfile): PermissionTemplate {
  switch (profile) {
    case "strict":
      return PERMISSION_TEMPLATES.strict;
    case "standard":
      return PERMISSION_TEMPLATES.standard;
    case "trusted":
      return PERMISSION_TEMPLATES.trusted;
  }
}
