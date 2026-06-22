import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_IMAGE_BYTES } from "@roamcli/shared/protocol";
import {
  CodexJsonParser,
  agentPlugin,
  approvalResponsePayload,
  codexAgent,
  codexJsonArgs,
  listCodexSkills,
  parseArgs,
} from "./index.js";

const execFileAsync = promisify(execFile);

describe("codex agent plugin", () => {
  it("builds the default codex capability", () => {
    expect(
      codexAgent.buildCapability({ profile: "trusted", env: {} }),
    ).toMatchObject({
      kind: "codex",
      label: "Codex",
      command: "codex",
      args: [
        "exec",
        "--json",
        "--color",
        "never",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
      ],
      parser: "codex-json",
      supportsResume: true,
      supportsImages: true,
      supportedImageMimeTypes: ["image/png", "image/jpeg"],
      maxImagesPerTurn: 5,
      maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
      pluginName: "@roamcli/agent-codex",
    });
  });

  it("exposes a default plugin with one codex agent", () => {
    expect(
      agentPlugin
        .agents({ profile: "standard", env: {} })
        .map((agent) => agent.kind),
    ).toEqual(["codex"]);
  });

  it("builds codex json resume args with the stored thread id and prompt argument", () => {
    expect(
      codexJsonArgs(
        [
          "exec",
          "--json",
          "--color",
          "never",
          "--skip-git-repo-check",
          "--dangerously-bypass-approvals-and-sandbox",
        ],
        "next prompt",
        "thread-1",
      ),
    ).toEqual([
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "thread-1",
      "next prompt",
    ]);
  });

  it("passes image paths to codex exec and resume invocations", () => {
    expect(
      codexJsonArgs(["exec", "--json"], "describe image", undefined, [
        "/tmp/a.png",
        "/tmp/b.jpg",
      ]),
    ).toEqual([
      "exec",
      "--json",
      "describe image",
      "--image",
      "/tmp/a.png",
      "--image",
      "/tmp/b.jpg",
    ]);

    expect(
      codexJsonArgs(
        ["exec", "--json", "--color", "never"],
        "resume image",
        "thread-1",
        ["/tmp/a.png"],
      ),
    ).toEqual([
      "exec",
      "resume",
      "--json",
      "thread-1",
      "resume image",
      "--image",
      "/tmp/a.png",
    ]);
  });

  it("extracts complete assistant messages from codex json events", () => {
    const parser = new CodexJsonParser();

    const result = parser.feed(
      [
        '{"type":"thread.started","thread_id":"codex-thread-1"}',
        '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"Projects:\\n- roam-cli"}}',
        "",
      ].join("\n"),
    );

    expect(result.threadId).toBe("codex-thread-1");
    expect(result.text).toBe("");
    expect(result.messages).toEqual(["Projects:\n- roam-cli"]);
  });

  it("keeps multiple completed codex messages separated", () => {
    const parser = new CodexJsonParser();

    const result = parser.feed(
      [
        '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"first"}}',
        '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"second"}}',
        "",
      ].join("\n"),
    );

    expect(result.messages).toEqual(["first", "second"]);
  });

  it("extracts approval directives from codex assistant text", () => {
    const parser = new CodexJsonParser();

    const result = parser.feed(
      `${JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "agent_message",
          text: 'ROAMCLI_APPROVAL: {"type":"approval_request","kind":"execCommand","summary":"Run tests","payload":{"command":"pnpm test"}}',
        },
      })}\n`,
    );

    expect(result.approvals).toEqual([
      {
        kind: "execCommand",
        summary: "Run tests",
        payload: { command: "pnpm test" },
      },
    ]);
  });

  it("includes approval IDs in subprocess approval response payloads", () => {
    expect(
      approvalResponsePayload({
        approvalId: "approval-1",
        approved: true,
        signedAt: "2026-06-21T00:00:00.000Z",
        signature: "signature",
      }),
    ).toEqual({
      type: "approvalResponse",
      approvalId: "approval-1",
      approved: true,
      signedAt: "2026-06-21T00:00:00.000Z",
      signature: "signature",
    });
  });

  it("supports JSON array and shell-like args overrides", () => {
    expect(parseArgs('["--one","two words"]')).toEqual(["--one", "two words"]);
    expect(parseArgs('exec --sandbox "danger full"')).toEqual([
      "exec",
      "--sandbox",
      "danger full",
    ]);
  });

  it("lists codex skills from nearest project roots before global roots", async () => {
    const workspace = await mkdirTemp("roam-codex-skills-");
    const home = await mkdirTemp("roam-codex-home-");
    const repo = join(workspace, "repo");
    const sessionCwd = join(repo, "packages", "app");
    await mkdir(sessionCwd, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: repo });
    await writeSkill(
      join(sessionCwd, ".codex", "skills", "local-plan"),
      "plan",
      "Local plan",
    );
    await writeSkill(
      join(repo, ".agents", "skills", "repo-review"),
      "review",
      "Repo review",
    );
    await writeSkill(
      join(home, ".agents", "skills", "global-plan"),
      "plan",
      "Global plan",
    );
    await writeSkill(
      join(home, ".codex", "skills", "global-docs"),
      "docs",
      "Global docs",
    );
    const localSkillPath = await realpath(
      join(sessionCwd, ".codex", "skills", "local-plan"),
    );

    const skills = await listCodexSkills(workspace, sessionCwd, {
      HOME: home,
    });

    expect(skills.map((skill) => skill.name)).toEqual([
      "plan",
      "review",
      "docs",
    ]);
    expect(skills[0]).toMatchObject({
      name: "plan",
      description: "Local plan",
      sourceType: "project",
      sourcePath: localSkillPath,
    });
    expect(skills[2]).toMatchObject({
      name: "docs",
      sourceType: "global",
    });
  });

  it("lists CODEX_HOME skills before home fallback roots", async () => {
    const workspace = await mkdirTemp("roam-codex-skills-");
    const home = await mkdirTemp("roam-codex-home-");
    const codexHome = await mkdirTemp("roam-codex-custom-home-");
    const sessionCwd = join(workspace, "repo");
    await mkdir(sessionCwd, { recursive: true });
    await writeSkill(
      join(codexHome, "skills", "custom-docs"),
      "docs",
      "Custom Codex docs",
    );
    await writeSkill(
      join(home, ".agents", "skills", "global-review"),
      "review",
      "Global review",
    );
    await writeSkill(
      join(home, ".codex", "skills", "home-docs"),
      "docs",
      "Home Codex docs",
    );

    const skills = await listCodexSkills(workspace, sessionCwd, {
      CODEX_HOME: codexHome,
      HOME: home,
    });

    expect(skills.map((skill) => skill.name)).toEqual(["docs", "review"]);
    expect(skills[0]).toMatchObject({
      name: "docs",
      description: "Custom Codex docs",
      sourceType: "global",
    });
  });

  it("returns no skills when the configured base path escapes the workspace", async () => {
    const workspace = await mkdirTemp("roam-codex-skills-workspace-");
    const outside = await mkdirTemp("roam-codex-skills-outside-");

    await writeSkill(
      join(outside, ".codex", "skills", "outside"),
      "outside",
      "Outside",
    );

    await expect(
      listCodexSkills(workspace, outside, { HOME: outside }),
    ).resolves.toEqual([]);
  });
});

async function mkdirTemp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeSkill(
  directory: string,
  name: string,
  description: string,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${description}`, "---", ""].join(
      "\n",
    ),
  );
}
