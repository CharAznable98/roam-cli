# RoamCli

RoamCli is an open-source remote AI coding agent control platform. It connects a responsive web client, a central TypeScript server, and one or more development-machine runners over reverse WebSocket connections.

## What Is Included

This repository implements a usable MVP for remote agent control:

- Fastify server with token auth, SQLite persistence, local artifact storage, static web hosting, client stream WebSocket, and runner reverse WebSocket.
- Runner CLI with process management, PTY support, reconnect/cache, parser replay support, approval forwarding, audit hash chain, file tree/content RPCs, safe file writes, signed patch apply, and strict/standard/trusted profiles.
- React web client with responsive desktop/tablet/mobile layouts, runner/session controls, chat stream, file browser, editable text file panel, terminal input/stream, approval center, patch review, PWA manifest, and service worker.
- Shared protocol, security, and parser SDK packages with tests.
- Smoke/E2E gate that starts real Server + Runner and verifies session creation, persistence, file read/write, terminal input, bad patch signature rejection, and signed patch apply.

## Prerequisites

- Node.js 24 or newer.
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
```

`pnpm smoke:e2e` starts its own local Server and Runner, creates a real session, and verifies the MVP path without relying on mock HTTP responses.

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
6. Use the Approvals panel to accept/reject patch hunks and apply signed patches.

## Runner CLI Options

```text
--server      Server websocket URL. http/https are converted to ws/wss.
--token       Bearer token used for runner registration and patch signature verification.
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

## Server Environment

```text
HOST                         Bind host. Default: 127.0.0.1.
PORT                         Bind port. Default: 3000.
ROAMCLI_AUTH_TOKEN           Bearer token for HTTP and WebSocket auth.
ROAMCLI_APPROVAL_SECRET      HMAC secret for approvals and patch apply. Defaults to auth token.
ROAMCLI_DATA_DIR             SQLite/artifact data directory.
ROAMCLI_WEB_DIST             Path to built web assets. Defaults to apps/web/dist when available.
ROAMCLI_RUNNER_RPC_TIMEOUT_MS Runner RPC timeout. Default: 5000.
```

## Browser Validation

Install Playwright globally if you want to repeat the visual sanity check:

```bash
npm install -g playwright
playwright install chromium
```

Run the normal verification first:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:e2e
```

Then start Server + Runner as shown above and use Playwright to open `http://127.0.0.1:8787`.

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
scripts           Smoke/E2E runner.
docs              PRD status and task tracking.
```

## Notes

- Runtime state lives under `.roamcli-server/` and `.roam-runner/`; these are ignored by Git.
- Build output, Playwright screenshots, test reports, databases, and logs are ignored by Git.
- The current MVP uses bearer-token/HMAC signing. Runner-side patch apply re-verifies signatures, but production deployments should still add secret isolation, replay windows, HTTPS, OIDC or stronger auth, and audit export.
