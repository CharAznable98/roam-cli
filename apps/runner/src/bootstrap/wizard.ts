import React, { useMemo, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import {
  resolveRunnerConfigDraft,
  type RunnerConfigDraft,
} from "./cli.js";
import { reexecRunnerWithNpx } from "./npx-reexec.js";

type WizardField = "server" | "token" | "agentPlugins";

interface WizardResult {
  server: string;
  token: string;
  agentPlugins: string[];
}

export async function maybeRunRunnerWizard(
  argv: readonly string[],
): Promise<void> {
  const { options } = await resolveRunnerConfigDraft(argv);
  const missing = missingFields(options);
  if (missing.length === 0) {
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `Missing required runner options: ${missing.join(", ")}. Run interactively or pass the required flags.`,
    );
  }
  const result = await runWizard(options, missing);
  const runnerArgs = buildRunnerArgs(options, result);
  await reexecRunnerWithNpx({
    agentPlugins: result.agentPlugins,
    runnerArgs,
  });
}

function missingFields(options: RunnerConfigDraft): WizardField[] {
  const fields: WizardField[] = [];
  if (!options.server) {
    fields.push("server");
  }
  if (!options.token) {
    fields.push("token");
  }
  if (options.agentPlugins.length === 0) {
    fields.push("agentPlugins");
  }
  return fields;
}

async function runWizard(
  options: RunnerConfigDraft,
  fields: readonly WizardField[],
): Promise<WizardResult> {
  let result: WizardResult | undefined;
  const instance = render(
    React.createElement(RunnerWizard, {
      options,
      fields,
      onSubmit: (next: WizardResult) => {
        result = next;
      },
    }),
  );
  await instance.waitUntilExit();
  if (!result) {
    throw new Error("Runner setup was cancelled.");
  }
  return result;
}

function RunnerWizard({
  options,
  fields,
  onSubmit,
}: {
  options: RunnerConfigDraft;
  fields: readonly WizardField[];
  onSubmit: (result: WizardResult) => void;
}) {
  const { exit } = useApp();
  const [index, setIndex] = useState(0);
  const [input, setInput] = useState("");
  const [values, setValues] = useState<Partial<Record<WizardField, string>>>(
    {},
  );
  const field = fields[index] ?? fields[fields.length - 1];
  if (!field) {
    throw new Error("Runner setup has no fields to collect.");
  }
  const prompt = useMemo(() => fieldPrompt(field), [field]);

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === "c") {
      exit();
      return;
    }
    if (key.return) {
      const trimmed = input.trim();
      if (trimmed.length === 0) {
        return;
      }
      const nextValues = { ...values, [field]: trimmed };
      if (index < fields.length - 1) {
        setValues(nextValues);
        setInput("");
        setIndex(index + 1);
        return;
      }
      const server = options.server ?? nextValues.server;
      const token = options.token ?? nextValues.token;
      const agentPlugins =
        options.agentPlugins.length > 0
          ? options.agentPlugins
          : parseAgentPluginInput(nextValues.agentPlugins);
      if (!server || !token || agentPlugins.length === 0) {
        return;
      }
      onSubmit({ server, token, agentPlugins });
      exit();
      return;
    }
    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      return;
    }
    if (inputChar && !key.ctrl && !key.meta) {
      setInput((current) => current + inputChar);
    }
  });

  return React.createElement(
    Box,
    { flexDirection: "column", gap: 1 },
    React.createElement(Text, { bold: true }, "RoamCli Runner setup"),
    React.createElement(
      Text,
      null,
      `${prompt} ${field === "token" ? "*".repeat(input.length) : input}`,
    ),
    React.createElement(
      Text,
      { color: "gray" },
      "Press Enter to continue. Use comma-separated package names for plugins.",
    ),
  );
}

function fieldPrompt(field: WizardField | undefined): string {
  if (field === "server") {
    return "Server websocket URL:";
  }
  if (field === "token") {
    return "Runner token:";
  }
  return "Agent plugin package:";
}

function buildRunnerArgs(
  options: RunnerConfigDraft,
  result: WizardResult,
): string[] {
  const args = [
    "--server",
    result.server,
    "--token",
    result.token,
    "--profile",
    options.profile,
    "--workspace",
    options.workspace,
    "--data-dir",
    options.dataDir,
  ];
  if (options.runnerId) {
    args.push("--runner-id", options.runnerId);
  }
  for (const plugin of result.agentPlugins) {
    args.push("--agent-plugin", plugin);
  }
  return args;
}

function parseAgentPluginInput(value: string | undefined): string[] {
  return (
    value
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}
