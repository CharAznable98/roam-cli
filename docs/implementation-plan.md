# RoamCli Task Split

This implementation follows the PRD as a monorepo with four independently testable tracks.

## Track A: Shared Contracts

- `packages/shared/src/protocol`: Zod schemas and TypeScript types for runners, sessions, messages, approvals, artifacts, WebSocket events, and HTTP payloads.
- `packages/shared/src/security`: X25519 session key derivation, AES-256-GCM payload encryption, approval signing, and append-only audit hash chain verification.

## Track B: Server

- Fastify API gateway with token auth.
- SQLite persistence for sessions, messages, runners, approvals, and artifacts.
- Reverse runner WebSocket and client event stream WebSocket.
- Session routing, approval routing, local artifact storage, and static web serving.

## Track C: Runner

- Node CLI wrapper with reverse WebSocket registration.
- Child process lifecycle management, parser dispatch, stdin/stdout/stderr bridging, reconnect cache, permission profiles, audit JSONL, and artifact hashing.

## Track D: Web

- React/Vite/Tailwind responsive app.
- Mobile bottom tabs, tablet two-column, desktop three-column.
- Runner switcher, new session form, conversation stream, approvals, file/editor view, patch hunks, terminal stream, PWA assets, web push and voice-input feature detection.

## Verification

- Unit tests for shared contracts, encryption/signing/audit chain, server route behavior, runner process behavior, and web rendering.
- `pnpm build`, `pnpm test`, and `pnpm typecheck` are the required gates.
