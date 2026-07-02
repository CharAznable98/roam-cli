import { afterEach, describe, expect, it, vi } from "vitest";
import { getPermissionTemplate } from "../agents/permissions.js";
import { loadAgentRegistry } from "../agents/registry.js";

describe("capabilities", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers the default codex plugin", async () => {
    const registry = await loadAgentRegistry("standard");

    expect(registry.capabilities.map((capability) => capability.kind)).toEqual([
      "codex",
      "claude-code",
    ]);
    expect(registry.agents.map((agent) => agent.definition.kind)).toEqual([
      "codex",
      "claude-code",
    ]);
  });

  it("defines strict, standard, and trusted permission templates", () => {
    expect(getPermissionTemplate("strict").requireApprovalForShell).toBe(true);
    expect(getPermissionTemplate("standard").requireApprovalForApplyPatch).toBe(
      false,
    );
    expect(getPermissionTemplate("trusted").blockedCommands).toEqual([]);
  });

  it("uses codex app-server by default", async () => {
    const codex = (await loadAgentRegistry("trusted")).capabilities.find(
      (capability) => capability.kind === "codex",
    );

    expect(codex).toMatchObject({
      command: "codex",
      args: ["app-server", "proxy", "-c", "skip_git_repo_check=true"],
      parser: "codex-app-server",
      supportsResume: true,
      pluginName: "@roamcli/agent-codex",
    });
  });

  it("supports legacy per-agent command and args overrides", async () => {
    vi.stubEnv("ROAMCLI_AGENT_CODEX_MODE", "exec-json");
    vi.stubEnv("ROAMCLI_AGENT_CODEX_COMMAND", "local-codex");
    vi.stubEnv("ROAMCLI_AGENT_CODEX_ARGS", 'exec --sandbox "danger full"');

    const codex = (await loadAgentRegistry("standard")).capabilities.find(
      (capability) => capability.kind === "codex",
    );

    expect(codex).toMatchObject({
      command: "local-codex",
      args: ["exec", "--sandbox", "danger full"],
    });
  });

  it("supports legacy JSON array args overrides", async () => {
    vi.stubEnv("ROAMCLI_AGENT_CODEX_MODE", "exec-json");
    vi.stubEnv("ROAMCLI_AGENT_CODEX_ARGS", '["--one","two words"]');

    const codex = (await loadAgentRegistry("standard")).capabilities.find(
      (capability) => capability.kind === "codex",
    );

    expect(codex?.args).toEqual(["--one", "two words"]);
  });

  it("does not load Claude Code when only the Codex plugin is selected", async () => {
    vi.resetModules();
    vi.doMock("@roamcli/agent-claude-code", () => {
      throw new Error("Claude Code should not load");
    });
    try {
      const registryModule = await import("../agents/registry.js");
      const registry = await registryModule.loadAgentRegistry("standard", [
        "@roamcli/agent-codex",
      ]);

      expect(
        registry.capabilities.map((capability) => capability.kind),
      ).toEqual(["codex"]);
    } finally {
      vi.doUnmock("@roamcli/agent-claude-code");
      vi.resetModules();
    }
  });

  it("registers Claude Code as a first-party default plugin", async () => {
    const claudeCode = (await loadAgentRegistry("trusted")).capabilities.find(
      (capability) => capability.kind === "claude-code",
    );

    expect(claudeCode).toMatchObject({
      command: "claude",
      args: [],
      parser: "claude-agent-sdk",
      supportsResume: true,
      supportsImages: true,
      supportedImageMimeTypes: [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
      ],
      pluginName: "@roamcli/agent-claude-code",
    });
  });

  it("fails clearly when an external plugin cannot be loaded", async () => {
    await expect(
      loadAgentRegistry("standard", ["@roamcli/missing-agent"]),
    ).rejects.toThrow("Failed to load agent plugin @roamcli/missing-agent");
  });
});
