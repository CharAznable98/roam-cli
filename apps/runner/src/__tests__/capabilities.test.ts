import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCapabilities } from "../capabilities.js";
import { getPermissionTemplate } from "../permissions.js";

describe("capabilities", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers all supported agent wrappers", () => {
    expect(buildCapabilities("standard").map((capability) => capability.kind)).toEqual([
      "claude",
      "codex",
      "gemini",
      "aider",
      "mock",
      "shell"
    ]);
  });

  it("defines strict, standard, and trusted permission templates", () => {
    expect(getPermissionTemplate("strict").requireApprovalForShell).toBe(true);
    expect(getPermissionTemplate("standard").requireApprovalForApplyPatch).toBe(false);
    expect(getPermissionTemplate("trusted").blockedCommands).toEqual([]);
  });

  it("uses base codex startup without runner profile flags", () => {
    const codex = buildCapabilities("trusted").find((capability) => capability.kind === "codex");

    expect(codex).toMatchObject({ command: "codex", args: [] });
  });

  it("supports per-agent command and args overrides", () => {
    vi.stubEnv("ROAMCLI_AGENT_CODEX_COMMAND", "local-codex");
    vi.stubEnv("ROAMCLI_AGENT_CODEX_ARGS", "exec --sandbox \"danger full\"");

    const codex = buildCapabilities("standard").find((capability) => capability.kind === "codex");

    expect(codex).toMatchObject({ command: "local-codex", args: ["exec", "--sandbox", "danger full"] });
  });

  it("supports JSON array args overrides", () => {
    vi.stubEnv("ROAMCLI_AGENT_MOCK_ARGS", "[\"--one\",\"two words\"]");

    const mock = buildCapabilities("standard").find((capability) => capability.kind === "mock");

    expect(mock?.args).toEqual(["--one", "two words"]);
  });
});
