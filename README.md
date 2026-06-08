# RoamCli

RoamCli is an open-source remote AI coding agent control platform. It connects a responsive web client, a central TypeScript server, and one or more development-machine runners over reverse WebSocket connections.

Chinese documentation is available in [README_ch.md](README_ch.md).

## What Is Included

This repository implements a usable MVP for remote agent control:

- Fastify server with bearer-token auth, SQLite persistence, local artifact storage, static web hosting, client stream WebSocket, and runner reverse WebSocket.
- Runner CLI with process management, PTY fallback, reconnect/cache, parser replay support, approval forwarding, audit hash chain, file tree/content RPCs, safe UTF-8 file writes, signed patch apply, and strict/standard/trusted profiles.
- React web client with responsive desktop/tablet/mobile layouts, runner/session controls, chat stream, file browser, editable text file panel, terminal input/stream, approval center, patch review, PWA manifest, and service worker.
- Shared protocol, security, and parser SDK packages with tests.
- Smoke/E2E gate that starts real Server + Runner and verifies session creation, persistence, file read/write, terminal input, bad patch signature rejection, and signed patch apply.
- Browser blackbox gate that drives the real Web UI through Chromium across desktop, tablet, and mobile viewports.

## Prerequisites

- Node.js 24 or newer. The smoke script requires a runtime with global `WebSocket`.
- pnpm 10 or newer. This repo declares `packageManager: pnpm@10.33.0`.
- Git.
- Optional for browser validation: Playwright with Chromium.

If pnpm is not available:

```bash
corepack enable
corepack prepare pnpm@10.33.0 --activate
```

## Install

```bash
pnpm install
```

## Build And Test

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:e2e
pnpm blackbox:browser
```

`pnpm smoke:e2e` starts its own local Server and Runner by default, creates a real session with the `mock` agent, and verifies the MVP path without relying on mock HTTP responses.

`pnpm blackbox:browser` builds the app, starts a local Server and Runner, opens the real Web UI in Chromium, and verifies the empty-runner state plus desktop, tablet, and mobile user paths: chat, file browse/edit/save, terminal input, exec approval approve/reject, artifact display, and patch review/apply. By default it uses an isolated temporary Runner workspace; set `ROAMCLI_BLACKBOX_WORKSPACE` to point it at a specific workspace.

## Run Locally

Start the Server. It serves the built Web UI from `apps/web/dist` when that directory exists.

```bash
HOST=127.0.0.1 \
PORT=8787 \
ROAMCLI_AUTH_TOKEN=dev-token \
ROAMCLI_DATA_DIR=.roamcli-server \
ROAMCLI_RUNNER_RPC_TIMEOUT_MS=10000 \
pnpm --filter @roamcli/server dev
```

In another shell, start a Runner that exposes this repository as its workspace:

```bash
pnpm --filter @roamcli/runner dev \
  --server ws://127.0.0.1:8787/v1/runner \
  --token dev-token \
  --runner-id local-real \
  --workspace "$PWD" \
  --profile trusted
```

Open:

```text
http://127.0.0.1:8787
```

Use `dev-token` in the Web UI token field if it is not already filled.

## Create A Session

1. Confirm the runner appears in the left sidebar.
2. Create a new session with agent `mock` for local validation, or select `claude`, `codex`, `gemini`, `aider`, or `shell` when the corresponding CLI is installed on the runner machine.
3. Set the working directory to a path inside the runner workspace.
4. Use the Files panel to browse and edit UTF-8 text files.
5. Use the Terminal panel to send input to the active session.
6. Use the Approvals panel to accept/reject exec requests and apply signed patches.

## Runner CLI Options

```text
--server      Server websocket URL. http/https are converted to ws/wss.
--token       Bearer token used during websocket registration and patch signature verification.
--profile     Permission profile: strict, standard, trusted. Default: standard.
--runner-id   Stable runner id. Default: hostname plus UUID.
--workspace   Workspace root exposed to sessions. Default: cwd.
```

Equivalent environment variables are supported:

```text
ROAM_RUNNER_SERVER
ROAM_RUNNER_TOKEN
ROAM_RUNNER_PROFILE
ROAM_RUNNER_ID
ROAM_RUNNER_WORKSPACE
```

Agent commands and arguments can be overridden per agent kind:

```text
ROAMCLI_AGENT_CLAUDE_COMMAND
ROAMCLI_AGENT_CLAUDE_ARGS
ROAMCLI_AGENT_CODEX_COMMAND
ROAMCLI_AGENT_CODEX_ARGS
ROAMCLI_AGENT_GEMINI_COMMAND
ROAMCLI_AGENT_GEMINI_ARGS
ROAMCLI_AGENT_AIDER_COMMAND
ROAMCLI_AGENT_AIDER_ARGS
ROAMCLI_AGENT_MOCK_COMMAND
ROAMCLI_AGENT_MOCK_ARGS
ROAMCLI_AGENT_SHELL_COMMAND
ROAMCLI_AGENT_SHELL_ARGS
```

`*_ARGS` accepts either a shell-like string or a JSON string array.

## Server Environment

```text
HOST                         Bind host. Default: 127.0.0.1.
PORT                         Bind port. Default: 3000.
ROAMCLI_AUTH_TOKEN           Bearer token for HTTP and WebSocket auth.
ROAMCLI_APPROVAL_SECRET      HMAC secret for approvals and patch apply. Defaults to auth token.
ROAMCLI_DATA_DIR             SQLite/artifact data directory. Default: .roamcli-server.
ROAMCLI_WEB_DIST             Path to built web assets. Defaults to apps/web/dist or ../web/dist when available.
ROAMCLI_RUNNER_RPC_TIMEOUT_MS Runner RPC timeout. Default: 5000.
```

## Smoke/E2E Options

```text
ROAMCLI_SMOKE_BASE_URL            Connect to an existing server instead of starting one.
ROAMCLI_SMOKE_TOKEN               Bearer token. Default: dev-token.
ROAMCLI_SMOKE_RUNNER_ID           Runner id to use or start. Default: smoke-<pid>.
ROAMCLI_SMOKE_WORKSPACE           Workspace exposed to the runner. Default: repo root.
ROAMCLI_SMOKE_SKIP_BUILD=1        Skip protocol/security prebuild.
ROAMCLI_SMOKE_TIMEOUT_MS          Per-step timeout. Default: 30000.
ROAMCLI_SMOKE_EXPECT_PATCH_APPLY=0 Skip patch apply assertion.
```

## Browser Validation

Install Playwright browsers if Chromium is not already installed:

```bash
pnpm exec playwright install chromium
```

Run the normal verification first:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:e2e
pnpm blackbox:browser
```

Then start Server + Runner as shown above if you want to inspect the app manually.

`pnpm blackbox:browser` supports:

```text
ROAMCLI_BLACKBOX_BASE_URL       Connect to an existing server instead of starting one.
ROAMCLI_BLACKBOX_TOKEN          Bearer token. Default: dev-token.
ROAMCLI_BLACKBOX_RUNNER_ID      Runner id to use or start. Default: blackbox-<pid>.
ROAMCLI_BLACKBOX_WORKSPACE      Workspace exposed to the runner. Default: temporary isolated workspace.
ROAMCLI_BLACKBOX_TIMEOUT_MS     Per-step timeout. Default: 45000.
ROAMCLI_BLACKBOX_HEADFUL=1      Show Chromium while the test runs.
```

## Docker Compose

Build the Web UI before starting compose:

```bash
pnpm install
pnpm build
docker compose up --build
```

The compose setup is intended as a local deployment baseline. Add HTTPS, reverse proxy, persistent volume, backup, and auth hardening before exposing it publicly.

## Repository Layout

```text
apps/server       Fastify API, WebSocket hub, persistence, artifacts, static Web hosting.
apps/runner       Runner CLI, process adapter, file RPCs, patch apply, audit/cache.
apps/web          React client.
packages/protocol Shared Zod schemas and TypeScript types.
packages/security Crypto, signatures, hashes, audit helpers.
packages/parser-sdk Agent parser SDK and fixture replay tests.
scripts           Smoke/E2E and browser blackbox runners.
docs              PRD status and task tracking.
```

## Notes

- Runtime state lives under `.roamcli-server/` and `.roam-runner/`; these are ignored by Git.
- Build output, Playwright screenshots, test reports, databases, and logs are ignored by Git.
- The current MVP uses bearer-token/HMAC signing. Runner-side patch apply re-verifies signatures, but production deployments should still add secret isolation, replay windows, HTTPS, OIDC or stronger auth, and audit export.
- This project is licensed under EESPL 2.0. See [LICENSE](LICENSE).
