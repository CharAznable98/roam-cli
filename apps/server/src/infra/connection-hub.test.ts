import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import type { RunnerRegistration } from "@roamcli/shared/protocol";
import { describe, expect, it } from "vitest";
import { ConnectionHub } from "./connection-hub.js";
import type { ServerStore } from "./sqlite-store.js";

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = this.OPEN;
  readonly sent: string[] = [];

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = this.CLOSED;
    this.emit("close");
  }
}

describe("ConnectionHub", () => {
  it("reports open runner connections as healthy", () => {
    const store = createFakeStore();
    const hub = new ConnectionHub(store);

    hub.registerRunner(runner, new FakeSocket() as unknown as WebSocket);

    expect(hub.isRunnerConnectionHealthy("runner-1")).toBe(true);
    expect(hub.isRunnerOnline("runner-1")).toBe(true);
    expect(hub.listOnlineRunners()).toEqual([runner]);
  });

  it("reports stale socket runners as unhealthy", () => {
    const store = createFakeStore();
    const hub = new ConnectionHub(store);
    const socket = new FakeSocket();

    hub.registerRunner(runner, socket as unknown as WebSocket);
    socket.readyState = socket.CLOSED;

    expect(hub.isRunnerConnectionHealthy("runner-1")).toBe(false);
    expect(hub.isRunnerOnline("runner-1")).toBe(false);
    expect(hub.listOnlineRunners()).toEqual([]);
  });

  it("does not treat persisted online runners as live connections", () => {
    const store = createFakeStore([runner]);
    const hub = new ConnectionHub(store);

    expect(hub.isRunnerConnectionHealthy("runner-1")).toBe(false);
    expect(hub.isRunnerOnline("runner-1")).toBe(false);
    expect(hub.listOnlineRunners()).toEqual([]);
  });

  it("marks unhealthy runner connections offline and broadcasts removal", () => {
    const store = createFakeStore([runner]);
    const hub = new ConnectionHub(store);
    const stream = new FakeSocket();
    const runnerSocket = new FakeSocket();
    hub.addStream(stream as unknown as WebSocket);
    hub.registerRunner(runner, runnerSocket as unknown as WebSocket);

    hub.markRunnerOffline("runner-1");

    expect(runnerSocket.readyState).toBe(runnerSocket.CLOSED);
    expect(store.listOnlineRunners()).toEqual([]);
    expect(hub.listOnlineRunners()).toEqual([]);
    expect(JSON.parse(stream.sent.at(-1) ?? "{}")).toEqual({
      type: "runner:offline",
      runnerId: "runner-1",
    });
  });
});

type FakeStore = ServerStore & {
};

function createFakeStore(initialRunners: RunnerRegistration[] = []): FakeStore {
  const onlineRunners = new Map(
    initialRunners.map((runner) => [runner.runnerId, runner]),
  );
  return {
    setRunnerOnline(
      nextRunner: RunnerRegistration,
      online: boolean,
    ): RunnerRegistration {
      if (online) {
        onlineRunners.set(nextRunner.runnerId, nextRunner);
      } else {
        onlineRunners.delete(nextRunner.runnerId);
      }
      return nextRunner;
    },
    markRunnerOffline(runnerId: string): void {
      onlineRunners.delete(runnerId);
    },
    listOnlineRunners(): RunnerRegistration[] {
      return [...onlineRunners.values()];
    },
  } as unknown as FakeStore;
}

const runner: RunnerRegistration = {
  runnerId: "runner-1",
  displayName: "Runner One",
  hostname: "devbox.local",
  workspaceRoot: "/workspace",
  profile: "trusted",
  publicKey: "0123456789abcdef",
  capabilities: [],
  version: "1.1.0",
};
