import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseCliArgs,
  persistRunnerConfig,
  resolveRunnerConfig,
} from "../bootstrap/cli.js";
import { createRunner } from "../bootstrap/create-runner.js";

describe("parseCliArgs", () => {
  it("parses required runner flags and normalizes https to wss", () => {
    const options = parseCliArgs(
      [
        "--server",
        "https://roam.example.test/runners",
        "--token=t1",
        "--profile",
        "strict",
        "--runner-id",
        "r1",
        "--workspace",
        "/tmp/work",
      ],
      {},
    );

    expect(options).toEqual({
      server: "wss://roam.example.test/runners",
      token: "t1",
      profile: "strict",
      runnerId: "r1",
      workspace: "/tmp/work",
      dataDir: ".roam-runner",
      agentPlugins: [],
    });
  });

  it("parses repeatable agent plugin flags and env plugin lists", () => {
    expect(
      parseCliArgs(
        [
          "--server",
          "wss://example.test",
          "--agent-plugin",
          "@roamcli/agent-codex",
          "--agent-plugin=@vendor/foo-agent",
        ],
        {},
      ).agentPlugins,
    ).toEqual(["@roamcli/agent-codex", "@vendor/foo-agent"]);

    expect(
      parseCliArgs(["--server", "wss://example.test"], {
        ROAMCLI_AGENT_PLUGINS: "one,two",
      }).agentPlugins,
    ).toEqual(["one", "two"]);
  });

  it("rejects unsupported profiles", () => {
    expect(() =>
      parseCliArgs(
        ["--server", "wss://example.test", "--profile", "loose"],
        {},
      ),
    ).toThrow();
  });

  it("resolves cli options and writes a complete local config", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-config-"));
    const { options, configPath } = await resolveRunnerConfig(
      [
        "--server",
        "https://roam.example.test/runners",
        "--token",
        "t1",
        "--workspace",
        workspace,
      ],
      {},
    );

    await persistRunnerConfig(configPath, options);

    expect(configPath).toBe(join(workspace, ".roam-runner", "config.json"));
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      server: "wss://roam.example.test/runners",
      token: "t1",
      profile: "standard",
      runnerId: expect.stringContaining("-"),
      workspace,
      dataDir: ".roam-runner",
      agentPlugins: [],
    });
  });

  it("loads local config when no cli or env values are provided", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-config-"));
    await writeConfig(workspace, {
      server: "wss://roam.example.test/runners",
      token: "t1",
      profile: "trusted",
      runnerId: "stable-runner",
      workspace,
      dataDir: ".roam-runner",
      agentPlugins: ["@vendor/foo-agent"],
    });

    const { options } = await resolveRunnerConfig(
      ["--workspace", workspace],
      {},
    );

    expect(options).toEqual({
      server: "wss://roam.example.test/runners",
      token: "t1",
      profile: "trusted",
      runnerId: "stable-runner",
      workspace,
      dataDir: ".roam-runner",
      agentPlugins: ["@vendor/foo-agent"],
    });
  });

  it("keeps custom data-dir configs discoverable from the default locator", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-config-"));
    const { options, configPath } = await resolveRunnerConfig(
      [
        "--server",
        "https://roam.example.test/runners",
        "--token",
        "t1",
        "--workspace",
        workspace,
        "--data-dir",
        ".runner-state",
      ],
      {},
    );

    await persistRunnerConfig(configPath, options);

    const customConfigPath = join(workspace, ".runner-state", "config.json");
    const defaultConfigPath = join(workspace, ".roam-runner", "config.json");
    expect(configPath).toBe(customConfigPath);
    expect(JSON.parse(await readFile(customConfigPath, "utf8"))).toMatchObject({
      server: "wss://roam.example.test/runners",
      token: "t1",
      workspace,
      dataDir: ".runner-state",
    });
    expect(JSON.parse(await readFile(defaultConfigPath, "utf8"))).toMatchObject(
      {
        server: "wss://roam.example.test/runners",
        token: "t1",
        workspace,
        dataDir: ".runner-state",
      },
    );

    const { options: restoredOptions, configPath: restoredConfigPath } =
      await resolveRunnerConfig(["--workspace", workspace], {});
    expect(restoredConfigPath).toBe(defaultConfigPath);
    expect(restoredOptions).toMatchObject({
      server: "wss://roam.example.test/runners",
      token: "t1",
      workspace,
      dataDir: ".runner-state",
    });
  });

  it("keeps custom data-dir and default config copies in sync", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-config-"));
    const { options, configPath } = await resolveRunnerConfig(
      [
        "--server",
        "https://roam.example.test/runners",
        "--token",
        "t1",
        "--workspace",
        workspace,
        "--data-dir",
        ".runner-state",
      ],
      {},
    );
    await persistRunnerConfig(configPath, options);

    const { options: restoredOptions, configPath: restoredConfigPath } =
      await resolveRunnerConfig(
        [
          "--workspace",
          workspace,
          "--server",
          "https://override.example.test/runners",
          "--token",
          "t2",
        ],
        {},
      );
    await persistRunnerConfig(restoredConfigPath, restoredOptions);

    const customConfigPath = join(workspace, ".runner-state", "config.json");
    const defaultConfigPath = join(workspace, ".roam-runner", "config.json");
    const expected = {
      server: "wss://override.example.test/runners",
      token: "t2",
      workspace,
      dataDir: ".runner-state",
    };
    expect(JSON.parse(await readFile(defaultConfigPath, "utf8"))).toMatchObject(
      expected,
    );
    expect(JSON.parse(await readFile(customConfigPath, "utf8"))).toMatchObject(
      expected,
    );
  });

  it("prefers cli over env over local config and persists overrides", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-config-"));
    await writeConfig(workspace, {
      server: "wss://config.example.test/runners",
      token: "config-token",
      profile: "strict",
      runnerId: "config-runner",
      workspace,
      dataDir: ".roam-runner",
      agentPlugins: ["config-plugin"],
      ignored: true,
    });

    const { options, configPath } = await resolveRunnerConfig(
      [
        "--workspace",
        workspace,
        "--server",
        "https://cli.example.test/runners",
        "--agent-plugin",
        "cli-plugin",
      ],
      {
        ROAM_RUNNER_SERVER: "wss://env.example.test/runners",
        ROAM_RUNNER_TOKEN: "env-token",
        ROAM_RUNNER_PROFILE: "trusted",
        ROAM_RUNNER_ID: "env-runner",
        ROAMCLI_AGENT_PLUGINS: "env-plugin",
      },
    );

    await persistRunnerConfig(configPath, options);

    expect(options).toMatchObject({
      server: "wss://cli.example.test/runners",
      token: "env-token",
      profile: "trusted",
      runnerId: "env-runner",
      agentPlugins: ["cli-plugin"],
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      server: "wss://cli.example.test/runners",
      token: "env-token",
      profile: "trusted",
      runnerId: "env-runner",
      workspace,
      dataDir: ".roam-runner",
      agentPlugins: ["cli-plugin"],
    });
  });

  it("allows env plugin configuration to clear local config plugins", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-config-"));
    await writeConfig(workspace, {
      server: "wss://config.example.test/runners",
      token: "config-token",
      profile: "standard",
      runnerId: "config-runner",
      workspace,
      dataDir: ".roam-runner",
      agentPlugins: ["config-plugin"],
    });

    const { options } = await resolveRunnerConfig(["--workspace", workspace], {
      ROAMCLI_AGENT_PLUGINS: "",
    });

    expect(options.agentPlugins).toEqual([]);
  });

  it("fails when local config is malformed", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-config-"));
    const configPath = join(workspace, ".roam-runner", "config.json");
    await mkdir(join(workspace, ".roam-runner"), { recursive: true });
    await writeFile(configPath, "{", "utf8");

    await expect(
      resolveRunnerConfig(["--workspace", workspace], {}),
    ).rejects.toThrow(`Invalid runner config at ${configPath}`);
  });

  it("fails when local config fields are invalid", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-config-"));
    await writeConfig(workspace, {
      server: "wss://roam.example.test/runners",
      token: "t1",
      profile: "loose",
    });

    await expect(
      resolveRunnerConfig(["--workspace", workspace], {}),
    ).rejects.toThrow("Invalid runner config at");
  });

  it("allows cli and env overrides to repair stale invalid config values", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-config-"));
    await writeConfig(workspace, {
      server: "not a url",
      token: "config-token",
      profile: "loose",
    });

    const { options, configPath } = await resolveRunnerConfig(
      ["--workspace", workspace, "--server", "https://cli.example.test"],
      {
        ROAM_RUNNER_PROFILE: "trusted",
      },
    );
    await persistRunnerConfig(configPath, options);

    expect(options).toMatchObject({
      server: "wss://cli.example.test/",
      token: "config-token",
      profile: "trusted",
      dataDir: ".roam-runner",
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      server: "wss://cli.example.test/",
      token: "config-token",
      profile: "trusted",
      dataDir: ".roam-runner",
    });
  });

  it("does not persist unvalidated agent plugin configuration", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-config-"));
    const configPath = join(workspace, ".roam-runner", "config.json");

    await expect(
      createRunner([
        "--workspace",
        workspace,
        "--server",
        "wss://roam.example.test/runners",
        "--token",
        "t1",
        "--agent-plugin",
        "@roamcli/missing-agent",
      ]),
    ).rejects.toThrow("Failed to load agent plugin @roamcli/missing-agent");
    await expect(readFile(configPath, "utf8")).rejects.toThrow();
  });

  it("fails without a server or token after config resolution", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "roam-runner-config-"));

    await expect(
      resolveRunnerConfig(["--workspace", workspace], {}),
    ).rejects.toThrow(
      "Missing --server or ROAM_RUNNER_SERVER or local config server",
    );

    await expect(
      resolveRunnerConfig(
        ["--workspace", workspace, "--server", "wss://example.test"],
        {},
      ),
    ).rejects.toThrow(
      "Missing --token or ROAM_RUNNER_TOKEN or local config token",
    );
  });
});

async function writeConfig(
  workspace: string,
  config: Record<string, unknown>,
): Promise<void> {
  const configPath = join(workspace, ".roam-runner", "config.json");
  await mkdir(join(workspace, ".roam-runner"), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}
