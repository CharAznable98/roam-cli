import type { AgentKind, RunnerCapability, RunnerProfile } from "@roamcli/protocol";
import { getPermissionTemplate } from "./permissions.js";

const AGENTS: readonly AgentKind[] = ["claude", "codex", "gemini", "aider", "mock", "shell"];

export function buildCapabilities(profile: RunnerProfile): RunnerCapability[] {
  getPermissionTemplate(profile);
  return AGENTS.map((kind) => ({
    kind,
    label: labelFor(kind),
    command: commandFor(kind),
    args: argsFor(kind),
    parser: parserFor(kind),
    supportsResume: supportsResume(kind)
  }));
}

function labelFor(kind: AgentKind): string {
  switch (kind) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "gemini":
      return "Gemini CLI";
    case "aider":
      return "Aider";
    case "mock":
      return "Mock Agent";
    case "shell":
      return "Shell";
  }
}

function commandFor(kind: AgentKind): string {
  const override = process.env[`ROAMCLI_AGENT_${kind.toUpperCase()}_COMMAND`];
  if (override !== undefined && override.trim().length > 0) {
    return override.trim();
  }

  switch (kind) {
    case "claude":
      return "claude";
    case "codex":
      return "codex";
    case "gemini":
      return "gemini";
    case "aider":
      return "aider";
    case "mock":
      return process.execPath;
    case "shell":
      return process.env.SHELL ?? "sh";
  }
}

function argsFor(kind: AgentKind): string[] {
  const override = process.env[`ROAMCLI_AGENT_${kind.toUpperCase()}_ARGS`];
  if (override !== undefined) {
    return parseArgs(override);
  }

  if (kind === "codex") {
    return [
      "exec",
      "--json",
      "--color",
      "never",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox"
    ];
  }
  if (kind === "mock") {
    return [
      "-e",
      [
        "if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(true);",
        "process.stdin.resume();",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => process.stdout.write(chunk));"
      ].join("")
    ];
  }
  if (kind === "shell") {
    return ["-i"];
  }
  return [];
}

function parserFor(kind: AgentKind): string {
  return kind === "codex" ? "codex-json" : kind;
}

function supportsResume(kind: AgentKind): boolean {
  return kind !== "shell";
}

function parseArgs(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return [];
  }
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
      throw new Error("Agent args override must be a JSON string array");
    }
    return parsed;
  }

  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  for (const char of trimmed) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaped) {
    current += "\\";
  }
  if (quote !== undefined) {
    throw new Error("Unterminated quote in agent args override");
  }
  if (current.length > 0) {
    args.push(current);
  }
  return args;
}
