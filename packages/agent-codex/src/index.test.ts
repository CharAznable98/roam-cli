import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_IMAGE_BYTES } from "@roamcli/shared/protocol";
import {
  CodexJsonParser,
  agentPlugin,
  codexAgent,
  codexJsonArgs,
  parseArgs,
} from "./index.js";

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

  it("supports JSON array and shell-like args overrides", () => {
    expect(parseArgs('["--one","two words"]')).toEqual(["--one", "two words"]);
    expect(parseArgs('exec --sandbox "danger full"')).toEqual([
      "exec",
      "--sandbox",
      "danger full",
    ]);
  });
});
