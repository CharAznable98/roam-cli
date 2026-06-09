import { describe, expect, it, vi } from "vitest";
import { spawnAgentProcess } from "../agent-process.js";

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

    await expect(exit).resolves.toMatchObject({ code: 130 });
    expect(output).toContain("interrupted");
  });

  it("can close stdin for one-shot child processes", async () => {
    const child = await spawnAgentProcess(
      process.execPath,
      ["-e", "process.stdin.resume();process.stdin.on('end', () => { console.log('ended'); });"],
      {
        cwd: process.cwd(),
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
});
