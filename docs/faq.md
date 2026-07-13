# RoamCli FAQ

## What is RoamCli?

RoamCli is a self-hosted web UI and control plane for AI coding agents. It lets you start and supervise Codex, Claude Code, and other agent sessions from a browser while the actual repository access and command execution stay on machines you control.

## Who is RoamCli for?

RoamCli is for developers and teams that want a browser-based AI coding agent workspace without moving repositories or credentials into a hosted agent service. It is especially useful when the code needs to remain on a development machine, workstation, lab server, or private network runner.

## How is RoamCli different from a hosted coding agent?

Hosted coding agents usually run code in infrastructure owned by the service provider. RoamCli runs the agent process on your Runner machine, then streams session state, terminal output, file views, and approvals through a central Server that you host.

## Does the browser connect directly to a Runner?

No. The browser talks to the Server. Each Runner connects outbound to the Server over reverse WebSocket, so Runner machines usually do not need inbound ports open.

## Which coding agents are supported?

The workspace includes built-in plugins for:

- Codex through `@roamcli/agent-codex`
- Claude Code through `@roamcli/agent-claude-code`

The Runner loads agent capabilities through plugins, so additional agent integrations can be added without changing the core Runner.

## Do I need published npm packages?

No for the current source install path. Until the `@roamcli/*` packages are published, run the Runner from the source checkout:

```bash
ROAM_RUNNER_TOKEN=<runner-token> \
  pnpm --dir /path/to/roam-cli --filter @roamcli/runner dev -- \
  --server ws://127.0.0.1:8787/v1/runner \
  --workspace "$PWD" \
  --agent-plugin @roamcli/agent-codex
```

## Can I run the Server with Docker?

Yes. From a source checkout, run:

```bash
docker compose up --build
```

This starts only the Server. Start one or more Runners separately and point them at the Server.

## Where does RoamCli store data?

The Server stores SQLite data and artifacts under `ROAMCLI_DATA_DIR`. The Runner stores local runner state and non-secret config under `<workspace>/<data-dir>`, defaulting to `.roam-runner` under the exposed workspace. Runner tokens are never persisted there and must be supplied on every start.

## Can a Runner expose any directory?

The Runner exposes the configured workspace root. Projects are created under that root. Runner data directories reject absolute paths, parent traversal, and symlink components to keep local state scoped to the canonical workspace.

## Is RoamCli a replacement for Codex or Claude Code?

No. RoamCli is a control plane around coding agents. Codex, Claude Code, and other agent CLIs still provide the core coding-agent behavior.

## Is RoamCli open source?

Yes. RoamCli is licensed under the MIT License.
