import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../cli.js";

describe("parseCliArgs", () => {
  it("parses required runner flags and normalizes https to wss", () => {
    const options = parseCliArgs(
      ["--server", "https://roam.example.test/runners", "--token=t1", "--profile", "strict", "--runner-id", "r1", "--workspace", "/tmp/work"],
      {}
    );

    expect(options).toEqual({
      server: "wss://roam.example.test/runners",
      token: "t1",
      profile: "strict",
      runnerId: "r1",
      workspace: "/tmp/work"
    });
  });

  it("rejects unsupported profiles", () => {
    expect(() => parseCliArgs(["--server", "wss://example.test", "--profile", "loose"], {})).toThrow();
  });
});
