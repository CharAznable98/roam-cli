# RoamCli

Chinese documentation is available in [README_ch.md](README_ch.md).

RoamCli is a self-hosted web control plane for running AI coding agents on development machines. It connects a browser UI, a central TypeScript server, and one or more runners over reverse WebSocket connections, so you can start agent sessions, inspect project files, stream terminal output, handle approvals, and apply patches from the web.

## How It Works

RoamCli has three independent parts:

- **Server**: the central control plane. It serves the Web UI, HTTP API, WebSocket hub, SQLite data, and local artifact storage.
- **Runner**: a process that runs on a development machine or any machine that has access to your code. It connects back to the Server, starts agents, reads and writes workspace files, streams terminal output, and applies approved patches.
- **Web UI**: the browser interface served by the Server. The browser talks to the Server only; it does not need direct access to any Runner.

Runners use reverse WebSocket connections, so the machine running a Runner usually only needs outbound network access to the Server.

## Prerequisites

- Node.js 24 or newer.
- pnpm 10 or newer. This repo declares `packageManager: pnpm@10.33.0`.
- Git.
- A supported coding agent installed on the Runner machine. The default Runner plugin uses Codex.

## Install

```bash
pnpm install
pnpm build
```

`pnpm build` builds the Server packages and the Web UI assets that the Server can serve.

## Run RoamCli

Start the Server first. The Server is the central service that the Web UI and Runners connect to.

```bash
HOST=127.0.0.1 \
PORT=8787 \
ROAMCLI_AUTH_TOKEN=dev-token \
ROAMCLI_DATA_DIR=.roamcli-server \
pnpm --filter @roamcli/server dev
```

In another shell, start a Runner from the directory you want to expose as the Runner workspace:

```bash
pnpm --filter @roamcli/runner dev \
  --server ws://127.0.0.1:8787/v1/runner \
  --token dev-token \
  --runner-id local-dev \
  --workspace "$PWD" \
  --profile trusted
```

Open the Web UI:

```text
http://127.0.0.1:8787
```

Use `dev-token` in the Web UI token field if it is not already filled.

## Use RoamCli

1. Confirm that your Runner is online.
2. Create a Project. Select the Runner and enter a project directory as seen from that Runner.
3. Create a Session inside the Project.
4. Use the Chat panel to send prompts to the agent.
5. Use the Files panel to browse and edit UTF-8 text files inside the session directory.
6. Use the Terminal panel to send input to the active session.
7. Use the Approvals panel to approve or reject requests and apply accepted patches.

## Server Configuration

| Variable | Description | Default |
| --- | --- | --- |
| `HOST` | Server bind host. | `127.0.0.1` |
| `PORT` | Server bind port. | `3000` |
| `ROAMCLI_AUTH_TOKEN` | Bearer token for HTTP and WebSocket access. | unset |
| `ROAMCLI_DATA_DIR` | Directory for SQLite data and local artifacts. | `.roamcli-server` |
| `ROAMCLI_WEB_DIST` | Path to built Web UI assets. | auto-detects `apps/web/dist` or `../web/dist` |

## Runner Configuration

| CLI option | Environment variable | Description |
| --- | --- | --- |
| `--server` | `ROAM_RUNNER_SERVER` | Server WebSocket URL. `http` and `https` URLs are converted to `ws` and `wss`. |
| `--token` | `ROAM_RUNNER_TOKEN` | Bearer token used when connecting to the Server. |
| `--runner-id` | `ROAM_RUNNER_ID` | Stable Runner identifier. Defaults to hostname plus a generated UUID. |
| `--workspace` | `ROAM_RUNNER_WORKSPACE` | Workspace root exposed to RoamCli sessions. Defaults to the current directory. |
| `--profile` | `ROAM_RUNNER_PROFILE` | Runner profile: `strict`, `standard`, or `trusted`. Defaults to `standard`. |
| `--agent-plugin` | `ROAMCLI_AGENT_PLUGINS` | Agent plugin package to load. Repeatable by CLI, comma-separated by environment variable. |

## Agent Plugins

The Runner loads the Codex agent plugin by default. You can load additional agent plugins with `--agent-plugin` or `ROAMCLI_AGENT_PLUGINS`.

The Codex command and arguments can be overridden with:

```text
ROAMCLI_AGENT_CODEX_COMMAND
ROAMCLI_AGENT_CODEX_ARGS
```

`ROAMCLI_AGENT_CODEX_ARGS` accepts either a shell-like string or a JSON string array.

## Docker Compose

Docker Compose starts the Server only. You still need to start one or more Runners separately and point them at the Server.

```bash
docker compose up --build
```

The compose setup exposes the Server on port `8787` and persists Server data in the `roamcli-data` volume.

Start a Runner against the compose Server:

```bash
pnpm --filter @roamcli/runner dev \
  --server ws://127.0.0.1:8787/v1/runner \
  --token dev-token \
  --runner-id local-dev \
  --workspace "$PWD" \
  --profile trusted
```

## Repository Layout

```text
apps/server       Fastify API, WebSocket hub, persistence, artifacts, static Web hosting.
apps/runner       Runner CLI, agent process management, workspace file operations.
apps/web          React browser client.
packages/shared   Shared protocol schemas/types plus Node-side security helpers.
packages/agent-*  Agent plugin SDK and built-in Codex plugin.
```

## License

RoamCli is licensed under EESPL 2.0. See [LICENSE](LICENSE).
