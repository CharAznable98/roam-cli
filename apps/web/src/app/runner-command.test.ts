import { describe, expect, it } from "vitest";
import { buildRunnerCommand } from "./runner-command";

describe("buildRunnerCommand", () => {
  it("uses the current http host and port for the runner websocket URL", () => {
    expect(
      buildRunnerCommand("dev-token", {
        protocol: "http:",
        host: "127.0.0.1:63098",
      }),
    ).toContain("--server ws://127.0.0.1:63098/v1/runner");
  });

  it("uses wss when the web UI is served over https", () => {
    expect(
      buildRunnerCommand("secure-token", {
        protocol: "https:",
        host: "roam.example.com",
      }),
    ).toBe(
      "pnpm --filter @roamcli/runner dev --server wss://roam.example.com/v1/runner --token secure-token",
    );
  });

  it("falls back to dev-token when the token field is empty", () => {
    expect(
      buildRunnerCommand("", {
        protocol: "http:",
        host: "localhost:8787",
      }),
    ).toContain("--token dev-token");
  });
});
