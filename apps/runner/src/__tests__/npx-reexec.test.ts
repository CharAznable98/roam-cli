import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  buildNpxRunnerArgs,
  buildNpxRunnerInvocation,
  npxLauncher,
} from "../bootstrap/npx-reexec.js";

const runnerVersion = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("buildNpxRunnerArgs", () => {
  it("can launch the installed npx without a Windows shell", async () => {
    const invocation = npxLauncher(["--version"], process.env);
    const { stdout } = await promisify(execFile)(
      invocation.command,
      invocation.args,
      { windowsHide: true },
    );
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    if (process.platform === "win32")
      expect(invocation.command).toBe(process.execPath);
  });
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
      "--agent-plugin",
      "@roamcli/agent-codex",
      "--agent-plugin",
      "@vendor/custom-agent",
    ]);
  });

  it("moves runner tokens out of child argv and into its environment", () => {
    const invocation = buildNpxRunnerInvocation({
      agentPlugins: ["@roamcli/agent-codex"],
      runnerArgs: [
        "--server",
        "wss://roam.example.test/runners",
        "--token=runner-token",
        "--agent-plugin",
        "@roamcli/agent-codex",
      ],
      env: { PATH: "/bin" },
    });

    expect(invocation.args).not.toContain("runner-token");
    expect(invocation.args.some((arg) => arg.startsWith("--token"))).toBe(
      false,
    );
    expect(invocation.env).toMatchObject({
      PATH: "/bin",
      ROAM_RUNNER_TOKEN: "runner-token",
      ROAMCLI_RUNNER_REEXEC: "1",
    });
  });
});
