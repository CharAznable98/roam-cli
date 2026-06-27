import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CodexAppServerClient } from "./app-server-client.js";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
} from "./app-server-protocol.js";

describe("CodexAppServerClient", () => {
  it("matches JSON-RPC responses to pending requests", async () => {
    const child = fakeChild();
    const client = new CodexAppServerClient({
      child,
      onNotification: () => undefined,
      onRequest: () => undefined,
    });

    const result = client.request("thread/start", { cwd: "/workspace" });
    expect(child.writes()).toEqual([
      { id: 1, method: "thread/start", params: { cwd: "/workspace" } },
    ]);

    child.stdout.write(
      `${JSON.stringify({ id: 1, result: { thread: { id: "thread-1" } } })}\n`,
    );

    await expect(result).resolves.toEqual({ thread: { id: "thread-1" } });
  });

  it("dispatches notifications and server-initiated requests", async () => {
    const child = fakeChild();
    const notifications: JsonRpcNotification[] = [];
    const requests: JsonRpcRequest[] = [];
    new CodexAppServerClient({
      child,
      onNotification: (notification) => {
        notifications.push(notification);
      },
      onRequest: (request) => {
        requests.push(request);
      },
    });

    child.stdout.write(
      [
        JSON.stringify({
          method: "item/agentMessage/delta",
          params: { itemId: "item-1", delta: "hello" },
        }),
        JSON.stringify({
          id: 7,
          method: "item/commandExecution/requestApproval",
          params: { command: "pnpm test" },
        }),
        "",
      ].join("\n"),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notifications).toEqual([
      {
        method: "item/agentMessage/delta",
        params: { itemId: "item-1", delta: "hello" },
      },
    ]);
    expect(requests).toEqual([
      {
        id: 7,
        method: "item/commandExecution/requestApproval",
        params: { command: "pnpm test" },
      },
    ]);
  });

  it("writes server request responses", () => {
    const child = fakeChild();
    const client = new CodexAppServerClient({
      child,
      onNotification: () => undefined,
      onRequest: () => undefined,
    });

    client.respond(3, { decision: "accept" });
    client.reject(4, "unsupported", -32601);

    expect(child.writes()).toEqual([
      { id: 3, result: { decision: "accept" } },
      { id: 4, error: { code: -32601, message: "unsupported" } },
    ]);
  });
});

interface FakeChild extends ChildProcessWithoutNullStreams {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  writes(): unknown[];
}

function fakeChild(): FakeChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes: unknown[] = [];
  stdin.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (line.length > 0) {
        writes.push(JSON.parse(line));
      }
    }
  });
  return {
    stdin,
    stdout,
    stderr,
    writes: () => writes,
  } as unknown as FakeChild;
}
