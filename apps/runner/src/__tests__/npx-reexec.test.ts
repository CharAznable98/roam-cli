import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildNpxRunnerArgs } from "../bootstrap/npx-reexec.js";

const runnerVersion = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("buildNpxRunnerArgs", () => {
  it("pins the runner and official plugin packages while preserving import names", () => {
    expect(
      buildNpxRunnerArgs({
        agentPlugins: ["@roamcli/agent-codex", "@vendor/custom-agent"],
        runnerArgs: [
          "--server",
          "ws://127.0.0.1:8787/v1/runner",
          "--token",
          "runner-token",
          "--agent-plugin",
          "@roamcli/agent-codex",
          "--agent-plugin",
          "@vendor/custom-agent",
        ],
      }),
    ).toEqual([
      "--yes",
      "--package",
      `@roamcli/runner@${runnerVersion.version}`,
      "--package",
      `@roamcli/agent-codex@${runnerVersion.version}`,
      "--package",
      "@vendor/custom-agent",
      "--",
      "roam-runner",
      "--server",
      "ws://127.0.0.1:8787/v1/runner",
      "--token",
      "runner-token",
      "--agent-plugin",
      "@roamcli/agent-codex",
      "--agent-plugin",
      "@vendor/custom-agent",
    ]);
  });
});
