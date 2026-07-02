import { describe, expect, it } from "vitest";
import { createRoamApiClient } from "./client";

describe("createRoamApiClient", () => {
  it("does not send a JSON content-type header for requests without a body", async () => {
    const requests: Array<{
      url: string;
      method: string;
      headers: Headers;
      credentials: RequestCredentials | undefined;
    }> = [];
    const client = createRoamApiClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          method: init?.method ?? "GET",
          headers: new Headers(init?.headers),
          credentials: init?.credentials,
        });
        if (String(url).endsWith("/v1/runners")) {
          return Response.json({ runners: [] });
        }
        if (String(url).endsWith("/v1/projects")) {
          return Response.json({ projects: [] });
        }
        if (String(url).endsWith("/v1/sessions")) {
          return Response.json({ sessions: [] });
        }
        return new Response(null, { status: 204 });
      },
    });

    await client.loadInitialState();
    await client.deleteSession("session-1");

    expect(requests).toHaveLength(4);
    expect(requests.map((request) => request.method)).toEqual([
      "GET",
      "GET",
      "GET",
      "DELETE",
    ]);
    expect(
      requests.every((request) => request.headers.get("content-type") === null),
    ).toBe(true);
    expect(
      requests.every((request) => request.credentials === "same-origin"),
    ).toBe(true);
    expect(
      requests.every(
        (request) => request.headers.get("authorization") === null,
      ),
    ).toBe(true);
  });

  it("sends the session archive worktree strategy as a query parameter", async () => {
    let requestedUrl = "";
    const client = createRoamApiClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url) => {
        requestedUrl = String(url);
        return new Response(null, { status: 204 });
      },
    });

    await client.deleteSession("session-1", { worktree: "remove" });

    expect(requestedUrl).toBe(
      "http://127.0.0.1:8787/v1/sessions/session-1?worktree=remove",
    );
  });

  it("loads session summaries without fetching every session detail", async () => {
    const requests: string[] = [];
    const client = createRoamApiClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url) => {
        const path = new URL(String(url)).pathname;
        requests.push(path);
        if (path === "/v1/runners") {
          return Response.json({ runners: [] });
        }
        if (path === "/v1/projects") {
          return Response.json({ projects: [] });
        }
        if (path === "/v1/sessions") {
          return Response.json({
            sessions: [
              {
                id: "session-1",
                title: "Persisted session",
                projectId: "project-1",
                runnerId: "runner-1",
                agent: "codex",
                status: "completed",
                executionMode: "direct",
                executionFolder: ".",
                cwd: ".",
                createdAt: "2026-06-10T00:00:00.000Z",
                updatedAt: "2026-06-10T00:01:00.000Z",
              },
            ],
          });
        }
        return Response.json(
          { error: "unexpected detail request" },
          { status: 500 },
        );
      },
    });

    const initialState = await client.loadInitialState();

    expect(initialState.sessions).toHaveLength(1);
    expect(initialState.messages).toEqual([]);
    expect(requests).toEqual(["/v1/runners", "/v1/projects", "/v1/sessions"]);
  });

  it("formats worktree archive failures as user-facing messages", async () => {
    const client = createRoamApiClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async () =>
        Response.json(
          {
            error: "worktree_remove_failed",
            message: "Directory is not a git repository.",
            code: "GIT_OPERATION_ERROR",
          },
          { status: 409, statusText: "Conflict" },
        ),
    });

    await expect(
      client.deleteSession("session-1", { worktree: "remove" }),
    ).rejects.toThrow("Directory is not a git repository.");
    await expect(
      client.deleteSession("session-1", { worktree: "remove" }),
    ).rejects.not.toThrow(/\/v1\/sessions\/session-1|409 Conflict/);
  });

  it("formats offline worktree archive failures as user-facing messages", async () => {
    const client = createRoamApiClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async () =>
        Response.json(
          {
            error: "worktree_remove_failed",
            message: "runner is offline",
            code: "runner_offline",
          },
          { status: 409, statusText: "Conflict" },
        ),
    });

    await expect(
      client.deleteSession("session-1", { worktree: "remove" }),
    ).rejects.toThrow("runner is offline");
    await expect(
      client.deleteSession("session-1", { worktree: "remove" }),
    ).rejects.not.toThrow(/\/v1\/sessions\/session-1|409 Conflict/);
  });

  it("keeps raw HTTP context for unrelated session conflicts", async () => {
    const client = createRoamApiClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async () =>
        Response.json(
          { error: "runner_offline", message: "runner is offline" },
          { status: 409, statusText: "Conflict" },
        ),
    });

    await expect(
      client.deleteSession("session-1", { worktree: "remove" }),
    ).rejects.toThrow(
      "RoamCli API request /v1/sessions/session-1?worktree=remove failed with 409 Conflict: runner is offline.",
    );
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
            projectId: "project-1",
            runnerId: "runner-1",
            agent: "codex",
            status: "pending",
            executionMode: "direct",
            executionFolder: ".",
            cwd: ".",
            createdAt: "2026-06-10T00:00:00.000Z",
            updatedAt: "2026-06-10T00:00:00.000Z",
          },
        });
      },
    });

    await client.createSession({
      projectId: "project-1",
      agent: "codex",
      prompt: "hello",
    });

    expect(headers.get("content-type")).toBe("application/json");
  });

  it("fetches install metadata with a read-only GET request", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const client = createRoamApiClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, init) => {
        requestUrl = String(url);
        requestInit = init;
        return Response.json({
          install: {
            runnerPackageName: "@roamcli/runner",
            runnerPackageSpec: "@roamcli/runner@1.1.0",
            officialAgentPlugins: [
              {
                packageName: "@roamcli/agent-codex",
                packageSpec: "@roamcli/agent-codex@1.1.0",
                label: "Codex",
                description: "Runs sessions through Codex.",
              },
            ],
          },
        });
      },
    });

    const install = await client.fetchInstallMetadata();

    expect(requestUrl).toBe("http://127.0.0.1:8787/v1/install/metadata");
    expect(requestInit?.method ?? "GET").toBe("GET");
    expect(requestInit?.credentials).toBe("same-origin");
    expect(new Headers(requestInit?.headers).get("authorization")).toBeNull();
    expect(install.runnerPackageName).toBe("@roamcli/runner");
    expect(install.runnerPackageSpec).toBe("@roamcli/runner@1.1.0");
    expect(install.officialAgentPlugins[0]?.packageName).toBe(
      "@roamcli/agent-codex",
    );
    expect(install.officialAgentPlugins[0]?.packageSpec).toBe(
      "@roamcli/agent-codex@1.1.0",
    );
  });

  it("checks a session status with a POST request", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const client = createRoamApiClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, init) => {
        requestUrl = String(url);
        requestInit = init;
        return Response.json({
          session: {
            id: "session 1",
            title: "Checked session",
            projectId: "project-1",
            runnerId: "runner-1",
            agent: "codex",
            status: "stopped",
            executionMode: "direct",
            executionFolder: ".",
            cwd: ".",
            createdAt: "2026-06-10T00:00:00.000Z",
            updatedAt: "2026-06-10T00:01:00.000Z",
          },
        });
      },
    });

    const session = await client.checkSessionStatus("session 1");

    expect(requestUrl).toBe(
      "http://127.0.0.1:8787/v1/sessions/session%201/status/check",
    );
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.credentials).toBe("same-origin");
    expect(new Headers(requestInit?.headers).get("authorization")).toBeNull();
    expect(session.status).toBe("stopped");
  });

  it("fetches session details with a read-only GET request", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const client = createRoamApiClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, init) => {
        requestUrl = String(url);
        requestInit = init;
        return Response.json({
          session: {
            id: "session 1",
            title: "Persisted session",
            projectId: "project-1",
            runnerId: "runner-1",
            agent: "codex",
            status: "completed",
            executionMode: "direct",
            executionFolder: ".",
            cwd: ".",
            createdAt: "2026-06-10T00:00:00.000Z",
            updatedAt: "2026-06-10T00:01:00.000Z",
          },
          messages: [],
          attachments: [],
          approvals: [],
          artifacts: [],
        });
      },
    });

    const detail = await client.fetchSessionDetail("session 1");

    expect(requestUrl).toBe("http://127.0.0.1:8787/v1/sessions/session%201");
    expect(requestInit?.method ?? "GET").toBe("GET");
    expect(requestInit?.credentials).toBe("same-origin");
    expect(new Headers(requestInit?.headers).get("authorization")).toBeNull();
    expect(detail.session.status).toBe("completed");
  });

  it("patches session title updates", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const client = createRoamApiClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async (url, init) => {
        requestUrl = String(url);
        requestInit = init;
        return Response.json({
          session: {
            id: "session 1",
            title: "Renamed session",
            projectId: "project-1",
            runnerId: "runner-1",
            agent: "codex",
            status: "pending",
            executionMode: "direct",
            executionFolder: ".",
            cwd: ".",
            createdAt: "2026-06-10T00:00:00.000Z",
            updatedAt: "2026-06-10T00:01:00.000Z",
          },
        });
      },
    });

    const session = await client.updateSession("session 1", {
      title: "Renamed session",
    });

    expect(requestUrl).toBe("http://127.0.0.1:8787/v1/sessions/session%201");
    expect(requestInit?.method).toBe("PATCH");
    expect(new Headers(requestInit?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(requestInit?.credentials).toBe("same-origin");
    expect(new Headers(requestInit?.headers).get("authorization")).toBeNull();
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      title: "Renamed session",
    });
    expect(session.title).toBe("Renamed session");
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

  it("formats JSON API errors without exposing the raw response payload", async () => {
    const client = createRoamApiClient({
      baseUrl: "http://127.0.0.1:8787",
      fetchImpl: async () =>
        Response.json(
          { message: "Authentication required", debug: { requestId: "req-1" } },
          { status: 401, statusText: "Unauthorized" },
        ),
    });

    await expect(client.loadInitialState()).rejects.toThrow(
      "RoamCli API request /v1/runners failed with 401 Unauthorized: Authentication required.",
    );
    await expect(client.loadInitialState()).rejects.not.toThrow(
      /"debug"|"requestId"/,
    );
  });
});
