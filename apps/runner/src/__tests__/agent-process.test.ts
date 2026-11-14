import { describe, expect, it, vi } from "vitest";
import { spawnAgentProcess } from "../agents/process.js";

vi.mock("node-pty", () => ({
  spawn: () => {
    throw new Error("pty unavailable");
  }
}));

describe("AgentProcess", () => {
  it("does not fall back to pipes when a PTY is required", async () => {
    await expect(
      spawnAgentProcess(process.execPath, [], {
        cwd: process.cwd(),
        profile: "standard",
        requirePty: true
      })
    ).rejects.toThrow(`PTY spawn failed for ${process.execPath}: pty unavailable`);
  });

  it("maps interrupt to SIGINT for the child-process fallback", async () => {
    const child = await spawnAgentProcess(
      process.execPath,
      [
        "-e",
        [
          "process.on('SIGINT', () => { console.log('interrupted'); process.exit(130); });",
          "console.log('ready');",
          "setInterval(() => {}, 1000);"
        ].join("")
      ],
      {
        cwd: process.cwd(),
        profile: "standard",
        preferPty: false
      }
    );
    let output = "";
    child.onData((chunk) => {
      output += chunk.toString();
    });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.onExit(resolve);
    });

    await vi.waitFor(() => {
      expect(output).toContain("ready");
    });
    child.interrupt();

    await expect(exit).resolves.toMatchObject(process.platform === "win32" ? { signal: "SIGINT" } : { code: 130 });
    if (process.platform !== "win32") expect(output).toContain("interrupted");
  });

  it("can close stdin for one-shot child processes", async () => {
    const child = await spawnAgentProcess(
      process.execPath,
      ["-e", "process.stdin.resume();process.stdin.on('end', () => { console.log('ended'); });"],
      {
        cwd: process.cwd(),
        profile: "standard",
        preferPty: false
      }
    );
    let output = "";
    child.onData((chunk) => {
      output += chunk.toString();
    });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.onExit(resolve);
    });

    child.endInput();

    await expect(exit).resolves.toMatchObject({ code: 0 });
    expect(output).toContain("ended");
  });

  it("sanitizes environment variables before spawning an agent", async () => {
    const child = await spawnAgentProcess(
      process.execPath,
      [
        "-e",
        "console.log(JSON.stringify({ path: process.env.PATH, secret: process.env.ROAM_RUNNER_TOKEN }))",
      ],
      {
        cwd: process.cwd(),
        profile: "standard",
        env: { PATH: process.env.PATH, ROAM_RUNNER_TOKEN: "runner-secret" },
        preferPty: false,
      },
    );
    let output = "";
    child.onData((chunk) => {
      output += chunk.toString();
    });
    const exit = new Promise<{ code: number | null }>((resolve) => {
      child.onExit(resolve);
    });

    await expect(exit).resolves.toMatchObject({ code: 0 });
    expect(JSON.parse(output.trim())).toEqual({ path: process.env.PATH });
  });
});
