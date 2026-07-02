import { createHash } from "node:crypto";
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

  it("serializes same-chunk responses before later notifications", async () => {
    const child = fakeChild();
    const notificationStates: boolean[] = [];
    let responseContinuationRan = false;
    const client = new CodexAppServerClient({
      child,
      onNotification: () => {
        notificationStates.push(responseContinuationRan);
      },
      onRequest: () => undefined,
    });

    void client.request("turn/start").then(() => {
      responseContinuationRan = true;
    });
    child.stdout.write(
      [
        JSON.stringify({ id: 1, result: { turn: { id: "turn-1" } } }),
        JSON.stringify({
          method: "turn/completed",
          params: { turn: { id: "turn-1", status: "completed" } },
        }),
        "",
      ].join("\n"),
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(notificationStates).toEqual([true]);
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

  it("frames JSON-RPC messages over the app-server proxy websocket transport", async () => {
    const child = fakeRawChild();
    const client = new CodexAppServerClient({
      child,
      transport: "websocket",
      onNotification: () => undefined,
      onRequest: () => undefined,
    });

    const result = client.request("initialize", { experimentalApi: true });
    const handshake = child.writtenBytes().toString("utf8");
    const key = handshake.match(/Sec-WebSocket-Key: ([^\r\n]+)/)?.[1];
    expect(handshake).toContain("GET / HTTP/1.1\r\n");
    expect(handshake).toContain("Upgrade: websocket\r\n");
    expect(key).toBeDefined();

    child.stdout.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${webSocketAcceptKey(key ?? "")}`,
        "",
        "",
      ].join("\r\n"),
    );

    const framedRequest = decodeClientWebSocketTextFrame(
      child.writtenBytes().subarray(Buffer.byteLength(handshake)),
    );
    expect(JSON.parse(framedRequest)).toEqual({
      id: 1,
      method: "initialize",
      params: { experimentalApi: true },
    });

    child.stdout.write(
      webSocketTextFrame(JSON.stringify({ id: 1, result: { ok: true } })),
    );

    await expect(result).resolves.toEqual({ ok: true });
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

interface FakeRawChild extends ChildProcessWithoutNullStreams {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  writtenBytes(): Buffer;
}

function fakeRawChild(): FakeRawChild {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const writes: Buffer[] = [];
  stdin.on("data", (chunk) => {
    writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  return {
    stdin,
    stdout,
    stderr,
    writtenBytes: () => Buffer.concat(writes),
  } as unknown as FakeRawChild;
}

function webSocketAcceptKey(key: string): string {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function webSocketTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  }
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

function decodeClientWebSocketTextFrame(frame: Buffer): string {
  const firstByte = frame[0] ?? 0;
  const secondByte = frame[1] ?? 0;
  expect(firstByte & 0x0f).toBe(0x1);
  expect(secondByte & 0x80).toBe(0x80);
  let length = secondByte & 0x7f;
  let offset = 2;
  if (length === 126) {
    length = frame.readUInt16BE(offset);
    offset += 2;
  }
  const mask = frame.subarray(offset, offset + 4);
  offset += 4;
  const payload = frame.subarray(offset, offset + length);
  const unmasked = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    unmasked[index] = (payload[index] ?? 0) ^ (mask[index % mask.length] ?? 0);
  }
  return unmasked.toString("utf8");
}
