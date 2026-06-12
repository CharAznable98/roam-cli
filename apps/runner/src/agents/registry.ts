import { agentPlugin as codexPlugin } from "@roamcli/agent-codex";
import type { AgentDefinition, AgentPlugin, AgentPluginContext } from "@roamcli/agent-plugin-sdk";
import type { RunnerCapability, RunnerProfile } from "@roamcli/shared/protocol";
import { getPermissionTemplate } from "./permissions.js";

export const DEFAULT_AGENT_PLUGINS = ["@roamcli/agent-codex"] as const;

export interface LoadedAgent {
  definition: AgentDefinition;
  capability: RunnerCapability;
}

export interface AgentRegistry {
  capabilities: RunnerCapability[];
  agents: LoadedAgent[];
}

export async function loadAgentRegistry(
  profile: RunnerProfile,
  pluginNames: readonly string[] | undefined = DEFAULT_AGENT_PLUGINS,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentRegistry> {
  getPermissionTemplate(profile);
  const context: AgentPluginContext = { profile, env };
  const selectedPluginNames = pluginNames ?? DEFAULT_AGENT_PLUGINS;
  const plugins = await Promise.all(selectedPluginNames.map((name) => loadAgentPlugin(name)));
  const agents: LoadedAgent[] = [];
  const seen = new Set<string>();

  for (const plugin of plugins) {
    for (const definition of plugin.agents(context)) {
      if (seen.has(definition.kind)) {
        throw new Error(`Duplicate agent plugin kind: ${definition.kind}`);
      }
      seen.add(definition.kind);
      const capability = definition.buildCapability(context);
      agents.push({
        definition,
        capability: {
          ...capability,
          pluginName: capability.pluginName ?? plugin.name,
          pluginVersion: capability.pluginVersion ?? plugin.version,
        },
      });
    }
  }

  if (agents.length === 0) {
    throw new Error("No agent capabilities were registered by configured plugins");
  }

  return {
    agents,
    capabilities: agents.map((agent) => agent.capability),
  };
}

async function loadAgentPlugin(name: string): Promise<AgentPlugin> {
  if (name === "@roamcli/agent-codex") {
    return codexPlugin;
  }

  let loaded: unknown;
  try {
    loaded = await import(name);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load agent plugin ${name}: ${message}`);
  }

  const candidate = normalizePluginExport(loaded);
  if (!isAgentPlugin(candidate)) {
    throw new Error(`Agent plugin ${name} must export an AgentPlugin as default or agentPlugin`);
  }
  return candidate;
}

function normalizePluginExport(value: unknown): unknown {
  if (isRecord(value) && "agentPlugin" in value) {
    return value.agentPlugin;
  }
  if (isRecord(value) && "default" in value) {
    return value.default;
  }
  return value;
}

function isAgentPlugin(value: unknown): value is AgentPlugin {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    typeof value.agents === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
