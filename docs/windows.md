# Native Windows development

Use Node.js 24 or newer, pnpm 10 (the checkout pins 10.33.0), Git for Windows,
and an installed, authenticated agent. The Codex path has been verified with
the native Windows Codex executable. The runner's private state requires a
filesystem that supports Windows ACLs, such as NTFS, and the built-in Windows
PowerShell and `icacls` utilities.

From the checkout in PowerShell:

```powershell
pnpm install --frozen-lockfile
pnpm build
$env:HOST = '127.0.0.1'
$env:PORT = '8787'
$env:ROAMCLI_DATA_DIR = '.roamcli-server'
pnpm --filter @roamcli/server dev
```

Open `http://127.0.0.1:8787`, complete owner setup with the setup token printed
by the server, and copy the Runner token from **Account & Security**. In another
PowerShell terminal, replace the token and workspace path:

```powershell
$env:ROAM_RUNNER_TOKEN = '<runner-token>'
pnpm --filter @roamcli/runner dev -- `
  --server ws://127.0.0.1:8787/v1/runner `
  --workspace C:\MyWorkspace `
  --agent-plugin @roamcli/agent-codex
```

The default `standard` profile preserves Windows runtime/home directories,
`CODEX_HOME`, and HTTP/SOCKS proxy environment settings. It still removes the
Runner token and agent command override variables before launching agents.
When a local proxy is running, set its **actual** port in the Runner terminal:

```powershell
$env:HTTP_PROXY = 'http://127.0.0.1:<port>'
$env:HTTPS_PROXY = $env:HTTP_PROXY
$env:NO_PROXY = '127.0.0.1,localhost,::1'
```

With a TUN/virtual network adapter, use the system routing normally; no local
HTTP proxy port or these environment variables are needed.

## Verification

```powershell
pnpm test
pnpm typecheck
pnpm build
pnpm smoke:e2e
pnpm blackbox:browser
```

The default smoke and browser journeys use deterministic agent fixtures. They
exercise real Server/Runner processes, HTTP/WebSocket traffic, filesystem I/O,
Git worktrees, approvals and patch application. Browser tests fall back to an
installed Chrome or Edge on Windows if Playwright Chromium is missing; use
`$env:ROAMCLI_BROWSER_CHANNEL = 'msedge'` to choose explicitly. Reports and
screenshots are written to `artifacts/blackbox-browser/`.
The browser journeys block external HTTP resources; Monaco and its language
workers are bundled locally, so file editing and Git diffs do not require a CDN.

To additionally test a real Codex model call through Server → Runner → Codex,
authenticate the local Codex CLI first, then run:

```powershell
$env:ROAMCLI_SMOKE_REAL_AGENT = '1'
$env:ROAMCLI_SMOKE_TIMEOUT_MS = '300000'
pnpm smoke:e2e
Remove-Item Env:ROAMCLI_SMOKE_REAL_AGENT
Remove-Item Env:ROAMCLI_SMOKE_TIMEOUT_MS
```

This opt-in test asks the current Codex account to create a file with its editing
tools, verifies the actual file and persisted reply, then sends a follow-up and
checks that it resumes the same Codex thread. It also checks Runner file reads,
saves and patch application. Image fixture assertions remain covered by default smoke.
Without `ROAMCLI_SMOKE_WORKSPACE`, smoke creates and removes an isolated temporary
workspace rather than changing an existing workspace's Runner configuration.

Windows tests use junctions for directory-link coverage. Tests that require file
symlinks are explicitly skipped if the current account lacks the symlink
privilege; Developer Mode can enable that additional coverage. Tests requiring
POSIX-only filenames or ignoring SIGTERM are also explicitly marked. The
remaining ACL tests check actual Windows access rules, not POSIX mode bits.

Private Runner directories grant access to the current user, SYSTEM and local
Administrators. File data is still flushed before atomic replacement; Node
does not support flushing directory handles on Windows. Transient Windows
sharing errors are retried without a non-atomic delete/replace fallback.
