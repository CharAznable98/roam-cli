# Contributing

Thanks for considering a contribution to RoamCli.

## Development Setup

RoamCli is a pnpm workspace. Use Node.js 24 or newer and pnpm 10 or newer.

```bash
pnpm install
pnpm build
pnpm test
```

Start the Server locally:

```bash
HOST=127.0.0.1 \
PORT=8787 \
ROAMCLI_DATA_DIR=.roamcli-server \
pnpm --filter @roamcli/server dev
```

Start a local Runner from the workspace you want to expose:

```bash
pnpm --dir /path/to/roam-cli --filter @roamcli/runner dev -- \
  --server ws://127.0.0.1:8787/v1/runner \
  --token <runner-token> \
  --workspace "$PWD" \
  --agent-plugin @roamcli/agent-codex
```

## Before Opening a Pull Request

- Keep diffs focused and reversible.
- Add or update tests for behavior changes.
- Run the smallest relevant checks first, then broader checks when the change touches shared behavior.
- Update README or docs when user-facing behavior changes.

Recommended checks:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

## Repository Layout

```text
apps/server       Fastify API, WebSocket hub, persistence, artifacts, static Web hosting.
apps/runner       Runner CLI, agent process management, workspace file operations.
apps/web          React browser client.
packages/shared   Shared protocol schemas/types plus Node-side security helpers.
packages/agent-*  Agent plugin SDK and built-in Codex and Claude Code plugins.
```

## Security Reports

Do not open public issues for vulnerabilities. Follow [SECURITY.md](SECURITY.md).
