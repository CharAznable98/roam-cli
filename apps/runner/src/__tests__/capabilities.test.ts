import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentPlugin,
  AgentPluginContext,
} from "@roamcli/agent-plugin-sdk";
import {
  getPermissionTemplate,
  sanitizeAgentEnvironment,
} from "../agents/permissions.js";
import { loadAgentRegistry } from "../agents/registry.js";

describe("capabilities", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires at least one agent plugin", async () => {
    await expect(loadAgentRegistry("standard", [])).rejects.toThrow(
      "Missing --agent-plugin",
    );
  });

  it("registers selected first-party plugins", async () => {
    const registry = await loadAgentRegistry("standard", [
      "@roamcli/agent-codex",
      "@roamcli/agent-claude-code",
    ]);

    expect(registry.capabilities.map((capability) => capability.kind)).toEqual([
      "codex",
      "claude-code",
    ]);
    expect(registry.agents.map((agent) => agent.definition.kind)).toEqual([
      "codex",
      "claude-code",
    ]);
    expect(
      registry.capabilities.every(
        (capability) => capability.supportsDurableSessionStart === true,
      ),
    ).toBe(true);
  });

  it("defines strict, standard, and trusted permission templates", () => {
    expect(getPermissionTemplate("strict").requireApprovalForShell).toBe(true);
    expect(getPermissionTemplate("standard").requireApprovalForApplyPatch).toBe(
      false,
    );
    expect(getPermissionTemplate("trusted").advisoryBlockedCommands).toEqual(
      [],
    );
    expect(getPermissionTemplate("standard").commandPolicyEnforcement).toBe(
      "agent",
    );
  });

  it("exposes only allowlisted environment values to restricted profiles", () => {
    const env = {
      PATH: "/bin",
      HOME: "/home/runner",
      USER: "runner",
      ROAM_RUNNER_TOKEN: "runner-secret",
      RoAm_RuNnEr_ToKeN: "mixed-case-runner-secret",
      ANTHROPIC_API_KEY: "provider-secret",
    };

    expect(sanitizeAgentEnvironment("strict", env)).toEqual({
      PATH: "/bin",
      HOME: "/home/runner",
    });
    expect(sanitizeAgentEnvironment("standard", env)).toEqual({
      PATH: "/bin",
      HOME: "/home/runner",
      USER: "runner",
    });
    expect(sanitizeAgentEnvironment("trusted", env)).toEqual({
      PATH: "/bin",
      HOME: "/home/runner",
      USER: "runner",
      ANTHROPIC_API_KEY: "provider-secret",
    });
  });

  it("uses codex app-server by default", async () => {
    const codex = (
      await loadAgentRegistry("trusted", ["@roamcli/agent-codex"])
    ).capabilities.find((capability) => capability.kind === "codex");

    expect(codex).toMatchObject({
      command: "codex",
      args: ["app-server", "--stdio", "-c", "skip_git_repo_check=true"],
      parser: "codex-app-server",
      supportsResume: true,
      pluginName: "@roamcli/agent-codex",
    });
  });

  it("supports legacy per-agent command and args overrides for trusted runners", async () => {
    vi.stubEnv("ROAMCLI_AGENT_CODEX_MODE", "exec-json");
    vi.stubEnv("ROAMCLI_AGENT_CODEX_COMMAND", "local-codex");
    vi.stubEnv("ROAMCLI_AGENT_CODEX_ARGS", 'exec --sandbox "danger full"');

    const codex = (
      await loadAgentRegistry("trusted", ["@roamcli/agent-codex"])
    ).capabilities.find((capability) => capability.kind === "codex");

    expect(codex).toMatchObject({
      command: "local-codex",
      args: ["exec", "--sandbox", "danger full"],
    });
  });

  it("supports legacy JSON array args overrides for trusted runners", async () => {
    vi.stubEnv("ROAMCLI_AGENT_CODEX_MODE", "exec-json");
    vi.stubEnv("ROAMCLI_AGENT_CODEX_ARGS", '["--one","two words"]');

    const codex = (
      await loadAgentRegistry("trusted", ["@roamcli/agent-codex"])
    ).capabilities.find((capability) => capability.kind === "codex");

    expect(codex?.args).toEqual(["--one", "two words"]);
  });

  it("re-sanitizes runtime contexts before invoking a restricted agent", async () => {
    const loaded = (
      await loadAgentRegistry("standard", ["@roamcli/agent-codex"], {})
    ).agents[0];
    if (loaded === undefined) {
      throw new Error("Codex agent was not loaded");
    }

    const capability = loaded.definition.buildCapability({
      profile: "trusted",
      env: {
        ROAMCLI_AGENT_CODEX_MODE: "exec-json",
        ROAMCLI_AGENT_CODEX_COMMAND: "malicious-override",
      },
    });

    expect(capability.command).toBe("codex");
    expect(capability.parser).toBe("codex-app-server");
  });

  it("sanitizes every plugin callback context but treats module code as trusted", async () => {
    const observed = new Map<string, NodeJS.ProcessEnv>();
    let moduleInitializationToken: string | undefined;
    const capture = (hook: string, context: AgentPluginContext) => {
      observed.set(hook, context.env);
    };
    vi.stubEnv("ROAM_RUNNER_TOKEN", "module-visible-secret");
    vi.resetModules();
    vi.doMock("@roamcli/agent-codex", () => {
      moduleInitializationToken = process.env.ROAM_RUNNER_TOKEN;
      const plugin: AgentPlugin = {
        name: "synthetic-plugin",
        version: "1.0.0",
        agents(context) {
          capture("agents", context);
          return [
            {
              kind: "synthetic",
              label: "Synthetic",
              buildCapability(callbackContext) {
                capture("buildCapability", callbackContext);
                return {
                  kind: "synthetic",
                  label: "Synthetic",
                  command: "synthetic",
                  args: [],
                  parser: "synthetic",
                  supportsResume: false,
                  supportsImages: false,
                  supportedImageMimeTypes: [],
                  maxImagesPerTurn: 0,
                  maxImageBytes: 1,
                };
              },
              createSession(callbackContext) {
                capture("createSession", callbackContext);
                return {
                  async start() {},
                  deliverInput() {},
                  control() {},
                  close() {},
                };
              },
              async listSkills(callbackContext) {
                capture("listSkills", callbackContext);
                return [];
              },
              async listRuntimeConfigOptions(callbackContext) {
                capture("listRuntimeConfigOptions", callbackContext);
                return {
                  queriedAt: "2026-07-10T00:00:00.000Z",
                  models: [],
                  allowCustomModel: false,
                  reasoningEfforts: [],
                  fastMode: { kind: "unsupported", supported: false },
                };
              },
            },
          ];
        },
      };
      return { default: plugin };
    });

    try {
      const registryModule = await import("../agents/registry.js");
      const registry = await registryModule.loadAgentRegistry(
        "standard",
        ["@roamcli/agent-codex"],
        {
          PATH: "/bin",
          ROAM_RUNNER_TOKEN: "context-secret",
          ROAMCLI_AGENT_CODEX_COMMAND: "context-override",
        },
      );
      const definition = registry.agents[0]?.definition;
      if (definition === undefined) {
        throw new Error("Synthetic agent was not loaded");
      }
      expect(
        registry.capabilities[0]?.supportsDurableSessionStart,
      ).toBeUndefined();
      const untrustedContext = {
        profile: "trusted",
        env: {
          PATH: "/bin",
          ROAM_RUNNER_TOKEN: "late-context-secret",
          ROAMCLI_AGENT_CODEX_COMMAND: "late-context-override",
        },
      } as const;
      definition.createSession(untrustedContext as never);
      await definition.listSkills?.(untrustedContext as never);
      await definition.listRuntimeConfigOptions?.(untrustedContext as never);

      expect(moduleInitializationToken).toBe("module-visible-secret");
      expect([...observed.keys()].sort()).toEqual([
        "agents",
        "buildCapability",
        "createSession",
        "listRuntimeConfigOptions",
        "listSkills",
      ]);
      for (const env of observed.values()) {
        expect(env).toEqual({ PATH: "/bin" });
        expect(env).not.toHaveProperty("ROAM_RUNNER_TOKEN");
        expect(env).not.toHaveProperty("ROAMCLI_AGENT_CODEX_COMMAND");
      }
    } finally {
      vi.doUnmock("@roamcli/agent-codex");
      vi.resetModules();
    }
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

  it("registers Claude Code when selected", async () => {
    const claudeCode = (
      await loadAgentRegistry("trusted", ["@roamcli/agent-claude-code"])
    ).capabilities.find((capability) => capability.kind === "claude-code");

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
