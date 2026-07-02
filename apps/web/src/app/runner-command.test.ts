import { describe, expect, it } from "vitest";
import { buildRunnerCommand } from "./runner-command";

describe("buildRunnerCommand", () => {
  it("uses the current http host and port for the runner websocket URL", () => {
    expect(
      buildRunnerCommand(
        "runner-token",
        undefined,
        ["@roamcli/agent-codex"],
        {
          protocol: "http:",
          host: "127.0.0.1:63098",
        },
      ),
    ).toContain("--server 'ws://127.0.0.1:63098/v1/runner'");
  });

  it("uses npx multi-package commands over https", () => {
    expect(
      buildRunnerCommand(
        "secure-token",
        {
          runnerPackageName: "@roamcli/runner",
          runnerPackageSpec: "@roamcli/runner@1.1.0",
          officialAgentPlugins: [
            {
              packageName: "@roamcli/agent-codex",
              packageSpec: "@roamcli/agent-codex@1.1.0",
              label: "Codex",
            },
            {
              packageName: "@roamcli/agent-claude-code",
              packageSpec: "@roamcli/agent-claude-code@1.1.0",
              label: "Claude Code",
            },
          ],
        },
        ["@roamcli/agent-codex", "@roamcli/agent-claude-code"],
        {
          protocol: "https:",
          host: "roam.example.com",
        },
      ),
    ).toBe(
      [
        "npx --yes \\",
        "  --package '@roamcli/runner@1.1.0' \\",
        "  --package '@roamcli/agent-codex@1.1.0' \\",
        "  --package '@roamcli/agent-claude-code@1.1.0' \\",
        "  -- roam-runner \\",
        "  --server 'wss://roam.example.com/v1/runner' \\",
        "  --token 'secure-token' \\",
        "  --agent-plugin '@roamcli/agent-codex' \\",
        "  --agent-plugin '@roamcli/agent-claude-code'",
      ].join("\n"),
    );
  });

  it("does not synthesize a token when the server has not provided one", () => {
    expect(
      buildRunnerCommand("", undefined, ["@roamcli/agent-codex"], {
        protocol: "http:",
        host: "localhost:8787",
      }),
    ).toContain("--token ''");
  });

  it("quotes tokens so copied commands remain shell-safe", () => {
    expect(
      buildRunnerCommand(
        "pa ss'$(echo unsafe)",
        undefined,
        ["@vendor/foo-agent"],
        {
          protocol: "http:",
          host: "localhost:8787",
        },
      ),
    ).toContain("--token 'pa ss'\\''$(echo unsafe)'");
  });

  it("quotes custom plugin packages so copied commands remain shell-safe", () => {
    expect(
      buildRunnerCommand("runner-token", undefined, ["bad'$(echo plugin)"], {
        protocol: "http:",
        host: "localhost:8787",
      }),
    ).toContain("--package 'bad'\\''$(echo plugin)'");
  });
});
