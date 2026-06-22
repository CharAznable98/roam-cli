import { describe, expect, it } from "vitest";
import { buildRunnerCommand } from "./runner-command";

describe("buildRunnerCommand", () => {
  it("uses the current http host and port for the runner websocket URL", () => {
    expect(
      buildRunnerCommand("runner-token", {
        protocol: "http:",
        host: "127.0.0.1:63098",
      }),
    ).toContain("--server 'ws://127.0.0.1:63098/v1/runner'");
  });

  it("uses wss when the web UI is served over https", () => {
    expect(
      buildRunnerCommand("secure-token", {
        protocol: "https:",
        host: "roam.example.com",
      }),
    ).toBe(
      "pnpm --filter @roamcli/runner dev --server 'wss://roam.example.com/v1/runner' --token 'secure-token'",
    );
  });

  it("does not synthesize a token when the server has not provided one", () => {
    expect(
      buildRunnerCommand("", {
        protocol: "http:",
        host: "localhost:8787",
      }),
    ).toContain("--token ''");
  });

  it("quotes tokens so copied commands remain shell-safe", () => {
    expect(
      buildRunnerCommand("pa ss'$(echo unsafe)", {
        protocol: "http:",
        host: "localhost:8787",
      }),
    ).toContain("--token 'pa ss'\\''$(echo unsafe)'");
  });
});
