import { describe, expect, it } from "vitest";
import { createRoamApiClient } from "./api";

describe("createRoamApiClient", () => {
  it("explains HTML responses from API routes", async () => {
    const client = createRoamApiClient({
      baseUrl: "http://127.0.0.1:5175",
      fetchImpl: async () =>
        new Response("<!doctype html><html><body>Vite app</body></html>", {
          headers: { "content-type": "text/html" }
        })
    });

    await expect(client.loadInitialState()).rejects.toThrow(
      /returned HTML instead of JSON/,
    );
    await expect(client.loadInitialState()).rejects.toThrow(
      /Start the server on http:\/\/127\.0\.0\.1:8787/,
    );
  });

  it("explains empty proxy failures from API routes", async () => {
    const client = createRoamApiClient({
      baseUrl: "http://127.0.0.1:5175",
      fetchImpl: async () =>
        new Response("", {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "content-type": "text/plain" }
        })
    });

    await expect(client.loadInitialState()).rejects.toThrow(
      /Vite dev proxy cannot reach it/,
    );
  });
});
