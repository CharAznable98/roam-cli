# Comparison Notes

RoamCli sits in the self-hosted AI coding agent control-plane category. It is not an AI model, a hosted coding-agent service, or a replacement for Codex or Claude Code.

## RoamCli vs hosted AI coding agents

| Area               | RoamCli                            | Hosted agent service                   |
| ------------------ | ---------------------------------- | -------------------------------------- |
| Code execution     | Runs on your Runner machines       | Runs on provider infrastructure        |
| Repository access  | Kept on machines you control       | Usually granted to the provider        |
| Network shape      | Runner connects outbound to Server | Provider schedules remote environments |
| Browser UI         | Served by your Server              | Served by provider                     |
| Operational burden | You host and update RoamCli        | Provider hosts the service             |

Use RoamCli when the control plane should be browser-based but execution should stay local, self-hosted, or inside a private network.

## RoamCli vs running Codex or Claude Code directly

| Area             | RoamCli                    | Direct CLI                     |
| ---------------- | -------------------------- | ------------------------------ |
| Session access   | Browser UI over Server     | Local terminal                 |
| Multiple runners | First-class Runner concept | Manual shell access            |
| File browsing    | Built into Web UI          | Local editor or terminal tools |
| Approvals        | Central approval panel     | CLI-native approval flow       |
| Agent support    | Plugin-based               | One CLI at a time              |

Use direct CLIs for the simplest local workflow. Use RoamCli when you want a shared web control plane, remote supervision, browser-based file review, or multiple Runner machines.

## RoamCli vs self-hosted development workspaces

Self-hosted development workspaces focus on complete IDE or environment provisioning. RoamCli focuses on supervising AI coding agent sessions that run inside existing workspaces.

RoamCli can complement a self-hosted IDE by giving Codex, Claude Code, and other coding agents a browser-based session control plane.

## Related Concepts

- self-hosted AI coding agent control plane
- Codex web UI
- Claude Code web UI
- AI coding agent runner
- remote coding agent control plane
- browser UI for coding agents
- reverse WebSocket runner
- local code execution for AI agents
