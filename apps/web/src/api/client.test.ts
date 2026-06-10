import { describe, expect, it } from "vitest";
import { createRoamApiClient } from "./client";

describe("createRoamApiClient", () => {
  it("does not send a JSON content-type header for requests without a body", async () => {
    const requests: Array<{ url: string; method: string; headers: Headers }> =
      [];
    const client = createRoamApiClient({
      baseUrl: "http://127.0.0.1:8787",
      token: "dev-token",
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers),
        });
        if (String(url).endsWith("/v1/runners")) {
          return Response.json({ runners: [] });
        }
        if (String(url).endsWith("/v1/sessions")) {
          return Response.json({ sessions: [] });
        }
        return new Response(null, { status: 204 });
      },
    });

    await client.loadInitialState();
    await client.deleteSession("session-1");

    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "DELETE",
    ]);
    expect(
      requests.every((request) => request.headers.get("content-type") === null),
    ).toBe(true);
    expect(
      requests.every(
        (request) =>
          request.headers.get("authorization") === "Bearer dev-token",
      ),
    ).toBe(true);
  });

  it("sends a JSON content-type header for requests with a body", async () => {
    let headers = new Headers();
    const client = createRoamApiClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (_url, init) => {
        headers = new Headers(init?.headers);
        return Response.json({
          session: {
            id: "session-1",
            title: "Test",
            runnerId: "runner-1",
            agent: "codex",
            status: "pending",
            cwd: ".",
            createdAt: "2026-06-10T00:00:00.000Z",
            updatedAt: "2026-06-10T00:00:00.000Z",
          },
        });
      },
    });

    await client.createSession({
      runnerId: "runner-1",
      agent: "codex",
      cwd: ".",
      prompt: "hello",
    });

    expect(headers.get("content-type")).toBe("application/json");
  });

  it("explains HTML responses from API routes", async () => {
    const client = createRoamApiClient({
      baseUrl: "http://127.0.0.1:5175",
      fetchImpl: async () =>
        new Response("<!doctype html><html><body>Vite app</body></html>", {
          headers: { "content-type": "text/html" },
        }),
    });

    await expect(client.loadInitialState()).rejects.toThrow(
      /returned HTML instead of JSON/,
    );
    await expect(client.loadInitialState()).rejects.toThrow(
      /Check the API origin, reverse proxy, or WebSocket\/API routing configuration/,
    );
  });

  it("explains empty proxy failures from API routes", async () => {
    const client = createRoamApiClient({
      baseUrl: "http://127.0.0.1:5175",
      fetchImpl: async () =>
        new Response("", {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "content-type": "text/plain" },
        }),
    });

    await expect(client.loadInitialState()).rejects.toThrow(
      /development proxy returned an empty server error/,
    );
  });
});
