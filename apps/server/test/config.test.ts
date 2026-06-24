import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("server config", () => {
  it("defaults runner RPC and queued Git jobs to 30 seconds", () => {
    const config = loadConfig({
      dataDir: "/tmp/roamcli-test",
      webDistDir: false,
    });

    expect(config.runnerRpcTimeoutMs).toBe(30_000);
    expect(config.gitJobTimeoutMs).toBe(30_000);
  });

  it("allows queued Git job timeout to be configured separately", () => {
    const config = loadConfig({
      dataDir: "/tmp/roamcli-test",
      webDistDir: false,
      runnerRpcTimeoutMs: 5_000,
      gitJobTimeoutMs: 30_000,
    });

    expect(config.runnerRpcTimeoutMs).toBe(5_000);
    expect(config.gitJobTimeoutMs).toBe(30_000);
  });
});
