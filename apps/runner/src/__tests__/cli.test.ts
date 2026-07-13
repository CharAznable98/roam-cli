import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseCliArgs,
  persistRunnerConfig,
  resolveRunnerDataDir,
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

  it("allows plaintext websocket connections only for loopback hosts", () => {
    expect(
      parseCliArgs(["--server", "http://localhost:8787/runners"], {}),
    ).toMatchObject({ server: "ws://localhost:8787/runners" });
    expect(
      parseCliArgs(["--server", "ws://127.0.0.1:8787/runners"], {}),
    ).toMatchObject({ server: "ws://127.0.0.1:8787/runners" });
    expect(() =>
      parseCliArgs(["--server", "ws://roam.example.test/runners"], {}),
    ).toThrow("Plaintext runner connections are limited to loopback hosts");
    expect(() =>
      parseCliArgs(["--server", "http://192.0.2.10/runners"], {}),
    ).toThrow("Plaintext runner connections are limited to loopback hosts");
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

  it("resolves cli options without persisting the runner token", async () => {
    const workspace = await createCanonicalWorkspace();
    const { options, configPath } = await resolveRunnerConfig(
      [
        "--server",
        "https://roam.example.test/runners",
        "--token",
        "t1",
        "--workspace",
        workspace,
        "--agent-plugin",
        "@roamcli/agent-codex",
      ],
      {},
    );

    await persistRunnerConfig(configPath, options);

    expect(configPath).toBe(join(workspace, ".roam-runner", "config.json"));
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      server: "wss://roam.example.test/runners",
      profile: "standard",
      runnerId: expect.stringContaining("-"),
      workspace,
      dataDir: ".roam-runner",
      agentPlugins: ["@roamcli/agent-codex"],
    });
    expect((await stat(dirname(configPath))).mode & 0o777).toBe(0o700);
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    expect(
      (await readdir(dirname(configPath))).filter((name) =>
        name.includes(".tmp-"),
      ),
    ).toEqual([]);
    expect(await readFile(configPath, "utf8")).not.toContain("t1");
  });

  it("loads local config when no cli or env values are provided", async () => {
    const workspace = await createCanonicalWorkspace();
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

  it("honors a discoverable local config workspace that points elsewhere", async () => {
    const invocationWorkspace = await createCanonicalWorkspace();
    const configuredWorkspace = await createCanonicalWorkspace();
    await writeConfig(invocationWorkspace, {
      server: "wss://roam.example.test/runners",
      token: "legacy-token",
      profile: "trusted",
      runnerId: "stable-runner",
      workspace: configuredWorkspace,
      dataDir: ".roam-runner",
      agentPlugins: ["@vendor/foo-agent"],
    });

    const { options, configPath } = await resolveRunnerConfig([], {
      INIT_CWD: invocationWorkspace,
    });

    expect(options.workspace).toBe(configuredWorkspace);
    expect(configPath).toBe(
      join(configuredWorkspace, ".roam-runner", "config.json"),
    );

    await persistRunnerConfig(configPath, options);
    expect(
      JSON.parse(await readFile(configPath, "utf8")),
    ).toMatchObject({ workspace: configuredWorkspace });
  });

  it("lets cli and env workspaces override a config workspace", async () => {
    const configWorkspace = await createCanonicalWorkspace();
    const cliWorkspace = await createCanonicalWorkspace();
    const envWorkspace = await createCanonicalWorkspace();
    for (const workspace of [cliWorkspace, envWorkspace]) {
      await writeConfig(workspace, {
        server: "wss://roam.example.test/runners",
        token: "legacy-token",
        workspace: configWorkspace,
        agentPlugins: ["@vendor/foo-agent"],
      });
    }

    const cliResult = await resolveRunnerConfig(
      ["--workspace", cliWorkspace],
      {},
    );
    expect(cliResult.options.workspace).toBe(cliWorkspace);
    expect(cliResult.configPath).toBe(
      join(cliWorkspace, ".roam-runner", "config.json"),
    );

    const envResult = await resolveRunnerConfig([], {
      INIT_CWD: configWorkspace,
      ROAM_RUNNER_WORKSPACE: envWorkspace,
    });
    expect(envResult.options.workspace).toBe(envWorkspace);
    expect(envResult.configPath).toBe(
      join(envWorkspace, ".roam-runner", "config.json"),
    );
  });

  it("uses the canonical invocation workspace when no workspace is configured", async () => {
    const invocationWorkspace = await createCanonicalWorkspace();
    const { options, configPath } = await resolveRunnerConfig(
      [
        "--server",
        "wss://roam.example.test/runners",
        "--token",
        "secret",
        "--agent-plugin",
        "@roamcli/agent-codex",
      ],
      { INIT_CWD: invocationWorkspace },
    );

    expect(options.workspace).toBe(invocationWorkspace);
    expect(configPath).toBe(
      join(invocationWorkspace, ".roam-runner", "config.json"),
    );
  });

  it("repairs permissive permissions before reading an existing config", async () => {
    const workspace = await createCanonicalWorkspace();
    await writeConfig(workspace, {
      server: "wss://roam.example.test/runners",
      token: "secret-token",
      profile: "standard",
      runnerId: "stable-runner",
      workspace,
      dataDir: ".roam-runner",
      agentPlugins: ["@roamcli/agent-codex"],
    });
    const configPath = join(workspace, ".roam-runner", "config.json");
    await chmod(configPath, 0o644);

    await resolveRunnerConfig(["--workspace", workspace], {});

    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  });

  it("reads a legacy persisted token once and removes it on migration", async () => {
    const workspace = await createCanonicalWorkspace();
    await writeConfig(workspace, {
      server: "wss://roam.example.test/runners",
      token: "legacy-secret",
      profile: "standard",
      runnerId: "stable-runner",
      workspace,
      dataDir: ".roam-runner",
      agentPlugins: ["@roamcli/agent-codex"],
    });

    const { options, configPath } = await resolveRunnerConfig(
      ["--workspace", workspace],
      {},
    );
    expect(options.token).toBe("legacy-secret");

    await persistRunnerConfig(configPath, options);

    expect(await readFile(configPath, "utf8")).not.toContain("legacy-secret");
    expect(JSON.parse(await readFile(configPath, "utf8"))).not.toHaveProperty(
      "token",
    );
    await expect(
      resolveRunnerConfig(["--workspace", workspace], {}),
    ).rejects.toThrow("Missing --token or ROAM_RUNNER_TOKEN");
  });

  it("canonicalizes a symlinked workspace before locating runner state", async () => {
    const root = await mkdtemp(join(tmpdir(), "roam-runner-config-"));
    const workspace = join(root, "workspace");
    const workspaceAlias = join(root, "workspace-alias");
    await mkdir(workspace);
    await symlink(workspace, workspaceAlias, "dir");

    const { options, configPath } = await resolveRunnerConfig(
      [
        "--workspace",
        workspaceAlias,
        "--server",
        "wss://roam.example.test/runners",
        "--token",
        "secret",
        "--agent-plugin",
        "@roamcli/agent-codex",
      ],
      {},
    );

    const canonicalWorkspace = await realpath(workspace);
    expect(options.workspace).toBe(canonicalWorkspace);
    expect(configPath).toBe(
      join(canonicalWorkspace, ".roam-runner", "config.json"),
    );
  });

  it("rejects symlinks in runner data directory components", async () => {
    const root = await mkdtemp(join(tmpdir(), "roam-runner-config-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await symlink(outside, join(workspace, ".roam-runner"), "dir");

    await expect(
      resolveRunnerConfig(
        [
          "--workspace",
          workspace,
          "--server",
          "wss://roam.example.test/runners",
          "--token",
          "secret",
          "--agent-plugin",
          "@roamcli/agent-codex",
        ],
        {},
      ),
    ).rejects.toThrow("Runner data path cannot contain symlinks");
  });

  it("hardens only the runner data directory under existing project directories", async () => {
    const workspace = await createCanonicalWorkspace();
    const toolsDirectory = join(workspace, "tools");
    const dataDirectory = join(toolsDirectory, ".roam-runner");
    await mkdir(toolsDirectory, { mode: 0o755 });
    await chmod(toolsDirectory, 0o755);
    await mkdir(dataDirectory, { mode: 0o777 });
    await chmod(dataDirectory, 0o777);

    await expect(
      resolveRunnerDataDir(workspace, "tools/.roam-runner", true),
    ).resolves.toBe(dataDirectory);

    expect((await stat(toolsDirectory)).mode & 0o777).toBe(0o755);
    expect((await stat(dataDirectory)).mode & 0o777).toBe(0o700);
  });

  it("still rejects symlinks in an existing parent of a nested data directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "roam-runner-config-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await symlink(outside, join(workspace, "tools"), "dir");

    await expect(
      resolveRunnerDataDir(workspace, "tools/.roam-runner", true),
    ).rejects.toThrow("Runner data path cannot contain symlinks");
  });

  it("rejects a symlinked custom data directory loaded from default config", async () => {
    const root = await mkdtemp(join(tmpdir(), "roam-runner-config-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await writeConfig(workspace, {
      server: "wss://roam.example.test/runners",
      token: "legacy-secret",
      profile: "standard",
      runnerId: "stable-runner",
      workspace,
      dataDir: ".custom-state",
      agentPlugins: ["@roamcli/agent-codex"],
    });
    await symlink(outside, join(workspace, ".custom-state"), "dir");

    await expect(
      resolveRunnerConfig(["--workspace", workspace], {}),
    ).rejects.toThrow("Runner data path cannot contain symlinks");
  });

  it("rejects a symlinked final config file without reading its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "roam-runner-config-"));
    const workspace = join(root, "workspace");
    const outsideConfig = join(root, "outside-config.json");
    const dataDirectory = join(workspace, ".roam-runner");
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(outsideConfig, '{"token":"outside-secret"}\n', "utf8");
    await symlink(outsideConfig, join(dataDirectory, "config.json"));

    await expect(
      resolveRunnerConfig(
        [
          "--workspace",
          workspace,
          "--server",
          "wss://roam.example.test/runners",
          "--token",
          "secret",
          "--agent-plugin",
          "@roamcli/agent-codex",
        ],
        {},
      ),
    ).rejects.toThrow("Runner config path cannot be a symlink");
    expect(await readFile(outsideConfig, "utf8")).toContain("outside-secret");
  });

  it("loads no-arg config from the package manager invocation directory", async () => {
    const workspace = await createCanonicalWorkspace();
    const { options, configPath } = await resolveRunnerConfig(
      [
        "--server",
        "https://roam.example.test/runners",
        "--token",
        "t1",
        "--workspace",
        workspace,
        "--agent-plugin",
        "@roamcli/agent-codex",
      ],
      {},
    );
    await persistRunnerConfig(configPath, options);

    await expect(
      resolveRunnerConfig([], { INIT_CWD: workspace }),
    ).rejects.toThrow("Missing --token or ROAM_RUNNER_TOKEN");

    const { options: restoredOptions, configPath: restoredConfigPath } =
      await resolveRunnerConfig([], {
        INIT_CWD: workspace,
        ROAM_RUNNER_TOKEN: "t2",
      });

    expect(restoredConfigPath).toBe(
      join(workspace, ".roam-runner", "config.json"),
    );
    expect(restoredOptions).toMatchObject({
      server: "wss://roam.example.test/runners",
      token: "t2",
      workspace,
      dataDir: ".roam-runner",
      agentPlugins: ["@roamcli/agent-codex"],
    });
  });

  it("keeps custom data-dir configs discoverable from the default locator", async () => {
    const workspace = await createCanonicalWorkspace();
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
        "--agent-plugin",
        "@roamcli/agent-codex",
      ],
      {},
    );

    await persistRunnerConfig(configPath, options);

    const customConfigPath = join(workspace, ".runner-state", "config.json");
    const defaultConfigPath = join(workspace, ".roam-runner", "config.json");
    expect(configPath).toBe(customConfigPath);
    expect(JSON.parse(await readFile(customConfigPath, "utf8"))).toMatchObject({
      server: "wss://roam.example.test/runners",
      workspace,
      dataDir: ".runner-state",
    });
    expect(JSON.parse(await readFile(defaultConfigPath, "utf8"))).toMatchObject(
      {
        server: "wss://roam.example.test/runners",
        workspace,
        dataDir: ".runner-state",
        agentPlugins: ["@roamcli/agent-codex"],
      },
    );

    const { options: restoredOptions, configPath: restoredConfigPath } =
      await resolveRunnerConfig(["--workspace", workspace], {
        ROAM_RUNNER_TOKEN: "t2",
      });
    expect(restoredConfigPath).toBe(defaultConfigPath);
    expect(restoredOptions).toMatchObject({
      server: "wss://roam.example.test/runners",
      token: "t2",
      workspace,
      dataDir: ".runner-state",
      agentPlugins: ["@roamcli/agent-codex"],
    });
  });

  it("validates every config copy before replacing an existing file", async () => {
    const root = await mkdtemp(join(tmpdir(), "roam-runner-config-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    const { options, configPath } = await resolveRunnerConfig(
      [
        "--workspace",
        workspace,
        "--data-dir",
        ".runner-state",
        "--server",
        "wss://roam.example.test/runners",
        "--token",
        "secret",
        "--agent-plugin",
        "@roamcli/agent-codex",
      ],
      {},
    );
    await symlink(outside, join(workspace, ".roam-runner"), "dir");

    await expect(persistRunnerConfig(configPath, options)).rejects.toThrow(
      "Runner data path cannot contain symlinks",
    );
    await expect(
      readFile(join(workspace, ".runner-state", "config.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("keeps custom data-dir and default config copies in sync", async () => {
    const workspace = await createCanonicalWorkspace();
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
        "--agent-plugin",
        "@roamcli/agent-codex",
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
          "--agent-plugin",
          "@roamcli/agent-claude-code",
        ],
        {},
      );
    await persistRunnerConfig(restoredConfigPath, restoredOptions);

    const customConfigPath = join(workspace, ".runner-state", "config.json");
    const defaultConfigPath = join(workspace, ".roam-runner", "config.json");
    const expected = {
      server: "wss://override.example.test/runners",
      workspace,
      dataDir: ".runner-state",
      agentPlugins: ["@roamcli/agent-claude-code"],
    };
    expect(JSON.parse(await readFile(defaultConfigPath, "utf8"))).toMatchObject(
      expected,
    );
    expect(JSON.parse(await readFile(customConfigPath, "utf8"))).toMatchObject(
      expected,
    );
  });

  it("prefers cli over env over local config and persists overrides", async () => {
    const workspace = await createCanonicalWorkspace();
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
      profile: "trusted",
      runnerId: "env-runner",
      workspace,
      dataDir: ".roam-runner",
      agentPlugins: ["cli-plugin"],
    });
  });

  it("rejects env plugin configuration that clears local config plugins", async () => {
    const workspace = await createCanonicalWorkspace();
    await writeConfig(workspace, {
      server: "wss://config.example.test/runners",
      token: "config-token",
      profile: "standard",
      runnerId: "config-runner",
      workspace,
      dataDir: ".roam-runner",
      agentPlugins: ["config-plugin"],
    });

    await expect(
      resolveRunnerConfig(["--workspace", workspace], {
        ROAMCLI_AGENT_PLUGINS: "",
      }),
    ).rejects.toThrow(
      "Missing --agent-plugin or ROAMCLI_AGENT_PLUGINS or local config agentPlugins",
    );
  });

  it("fails when local config is malformed", async () => {
    const workspace = await createCanonicalWorkspace();
    const configPath = join(workspace, ".roam-runner", "config.json");
    await mkdir(join(workspace, ".roam-runner"), { recursive: true });
    await writeFile(configPath, "{", "utf8");

    await expect(
      resolveRunnerConfig(["--workspace", workspace], {}),
    ).rejects.toThrow(`Invalid runner config at ${configPath}`);
  });

  it("fails when local config fields are invalid", async () => {
    const workspace = await createCanonicalWorkspace();
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
    const workspace = await createCanonicalWorkspace();
    await writeConfig(workspace, {
      server: "not a url",
      token: "config-token",
      profile: "loose",
      agentPlugins: ["config-plugin"],
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
      profile: "trusted",
      dataDir: ".roam-runner",
    });
  });

  it("does not persist unvalidated agent plugin configuration", async () => {
    const workspace = await createCanonicalWorkspace();
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
    const workspace = await createCanonicalWorkspace();

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
    ).rejects.toThrow("Missing --token or ROAM_RUNNER_TOKEN");
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

async function createCanonicalWorkspace(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "roam-runner-config-")));
}
