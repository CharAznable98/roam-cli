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
- Docker and Docker Compose for the Server installer.
- A supported coding agent installed on the Runner machine for each selected agent plugin, for example Codex for `@roamcli/agent-codex`.

## Install

### Server: Docker Installer

The recommended Server install path is the release installer script. It runs on macOS and Linux, checks for Git, Docker, and Docker Compose, clones the selected release tag, builds the Server image locally, and starts it with Docker Compose. RoamCli does not require a published Docker image.

```bash
curl -fsSL https://github.com/CharAznable98/roam-cli/releases/latest/download/install-server.sh -o install-server.sh
chmod +x install-server.sh
./install-server.sh
```

Defaults:

- Install directory: `~/.roamcli/server`
- Server data directory: `~/.roamcli/server/data`
- Bind address: `0.0.0.0:8787`
- Release ref: latest GitHub release tag

Install or upgrade an older/specific version with the same script:

```bash
./install-server.sh --version v1.1.0
```

Useful options:

```bash
./install-server.sh --public-origin https://roam.example.com
./install-server.sh --dry-run
./install-server.sh --uninstall
```

`--uninstall` stops and removes the generated Server deployment files. It asks for a second confirmation before deleting Server data; data is preserved by default.

Windows users should run the installer from WSL2 with Docker Desktop integration enabled, or use the source install path below.

### Server: Source Install

Use source install for local development or when you want to manage the process yourself:

```bash
pnpm install
pnpm build
```

`pnpm build` builds the Server packages and the Web UI assets that the Server can serve.

## Run RoamCli

If you installed the Server with `install-server.sh`, open the Web UI at the configured host and port. For a source checkout, start the Server first:

```bash
HOST=127.0.0.1 \
PORT=8787 \
ROAMCLI_DATA_DIR=.roamcli-server \
pnpm --filter @roamcli/server dev
```

On first start the Server prints a setup token and writes it to `.roamcli-server/setup-token.txt`. Open the Web UI, enter that setup token, and set the owner password. After setup, open **Account & Security** in the Web UI and copy the Runner token or full Runner command.

In another shell, start a Runner from the directory you want to expose as the Runner workspace. The Web UI generates this `npx` command after you select at least one agent plugin:

```bash
npx --yes \
  --package @roamcli/runner \
  --package @roamcli/agent-codex \
  -- roam-runner \
  --server ws://127.0.0.1:8787/v1/runner \
  --token <runner-token-from-account-security> \
  --agent-plugin @roamcli/agent-codex
```

The Runner writes the effective startup configuration to `<workspace>/<data-dir>/config.json`, defaulting to `.roam-runner/config.json` under the workspace. Later starts from the same workspace can omit persisted options, but the selected plugin packages still need to be available to `npx`:

```bash
npx --yes \
  --package @roamcli/runner \
  --package @roamcli/agent-codex \
  -- roam-runner
```

If required values are missing in an interactive terminal, the Runner opens a React Ink TUI wizard and then re-execs the complete `npx` command with the selected plugin packages. In non-interactive shells, pass `--server`, `--token`, and at least one `--agent-plugin` explicitly.

Open the Web UI:

```text
http://127.0.0.1:8787
```

## Use RoamCli

1. Confirm that your Runner is online.
2. Create a Project. Select the Runner; the UI fixes that Runner's workspace as the directory prefix, and you enter the relative project path under it.
3. Create a Session inside the Project.
4. Use the Chat panel to send prompts to the agent.
5. Use the Files panel to browse and edit UTF-8 text files inside the session directory.
6. Use the Terminal panel to send input to the active session.
7. Use the Approvals panel to approve or reject requests and apply accepted patches.

## Server Configuration

| Variable                | Description                                                                                                                                                 | Default                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `HOST`                  | Server bind host.                                                                                                                                           | `127.0.0.1`                                   |
| `PORT`                  | Server bind port.                                                                                                                                           | `3000`                                        |
| `ROAMCLI_DATA_DIR`      | Directory for SQLite data and local artifacts.                                                                                                              | `.roamcli-server`                             |
| `ROAMCLI_WEB_DIST`      | Path to built Web UI assets.                                                                                                                                | auto-detects `apps/web/dist` or `../web/dist` |
| `ROAMCLI_PUBLIC_ORIGIN` | Public browser origin allowed for mutating API calls, for example `https://roam.example.com`.                                                               | inferred from request host                    |
| `ROAMCLI_RESET_OWNER`   | Set to `1` on startup to clear owner credentials and Web sessions, then generate a new setup token. Runner tokens and project/session data are left intact. | unset                                         |

## Runner Configuration

Runner reads local config from `<workspace>/<data-dir>/config.json`. CLI options and environment variables override local config and are written back before the Runner connects.

| CLI option       | Environment variable    | Description                                                                                                                                                       |
| ---------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--server`       | `ROAM_RUNNER_SERVER`    | Server WebSocket URL. `http` and `https` URLs are converted to `ws` and `wss`.                                                                                    |
| `--token`        | `ROAM_RUNNER_TOKEN`     | Runner token shown in Account & Security.                                                                                                                         |
| `--runner-id`    | `ROAM_RUNNER_ID`        | Stable Runner identifier. Defaults to hostname plus a generated UUID.                                                                                             |
| `--workspace`    | `ROAM_RUNNER_WORKSPACE` | Workspace root exposed to RoamCli sessions. Defaults to the current directory.                                                                                    |
| `--data-dir`     | `ROAM_RUNNER_DATA_DIR`  | Relative runner data directory under the workspace for state and session worktrees. Defaults to `.roam-runner`. Absolute paths and parent traversal are rejected. |
| `--profile`      | `ROAM_RUNNER_PROFILE`   | Runner profile: `strict`, `standard`, or `trusted`. Defaults to `standard`.                                                                                       |
| `--agent-plugin` | `ROAMCLI_AGENT_PLUGINS` | Required agent plugin package to load. Repeatable by CLI, comma-separated by environment variable.                                                               |

## Agent Plugins

The Runner core is intentionally minimal and does not load a default agent plugin. Choose at least one plugin with `--agent-plugin` or `ROAMCLI_AGENT_PLUGINS`; when using `npx`, include each plugin package with `--package`.

Official plugin packages:

- `@roamcli/agent-codex`
- `@roamcli/agent-claude-code`

Multiple plugins are supported:

```bash
npx --yes \
  --package @roamcli/runner \
  --package @roamcli/agent-codex \
  --package @roamcli/agent-claude-code \
  -- roam-runner \
  --server ws://127.0.0.1:8787/v1/runner \
  --token <runner-token> \
  --agent-plugin @roamcli/agent-codex \
  --agent-plugin @roamcli/agent-claude-code
```

To pin old Runner/plugin versions, add npm versions to the `--package` values, for example `@roamcli/runner@1.1.0`. Local Runner config stores plugin import names only, not package versions.

The Codex plugin uses `codex app-server --stdio -c skip_git_repo_check=true` by default. The Codex command can be overridden with:

```text
ROAMCLI_AGENT_CODEX_COMMAND
```

Use `ROAMCLI_AGENT_CODEX_COMMAND` when the runner should launch a specific Codex binary or wrapper. App-server arguments are fixed to the stdio transport path.

The legacy `codex exec --json` invocation is still available only when explicitly selected:

```text
ROAMCLI_AGENT_CODEX_MODE=exec-json
ROAMCLI_AGENT_CODEX_ARGS
```

`ROAMCLI_AGENT_CODEX_ARGS` applies only in `exec-json` mode and accepts either a shell-like string or a JSON string array.

## Docker Compose

The root `docker-compose.yml` is for source checkouts. It starts the Server only; you still need to start one or more Runners separately and point them at the Server. Release downloads only need `install-server.sh`; the installer generates its own Compose file locally.

```bash
docker compose up --build
```

The compose setup exposes the Server on port `8787` and persists Server data in the `roamcli-data` volume.

Start a Runner against the compose Server:

```bash
npx --yes \
  --package @roamcli/runner \
  --package @roamcli/agent-codex \
  -- roam-runner \
  --server ws://127.0.0.1:8787/v1/runner \
  --token <runner-token-from-account-security> \
  --agent-plugin @roamcli/agent-codex
```

Subsequent starts from the same workspace can use the persisted local config:

```bash
npx --yes \
  --package @roamcli/runner \
  --package @roamcli/agent-codex \
  -- roam-runner
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
