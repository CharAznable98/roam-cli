# Security Policy

## Supported Versions

RoamCli is currently pre-1.0 style source-distributed software. Security fixes target the default branch unless a maintained release branch is documented.

## Reporting a Vulnerability

Please do not open a public GitHub issue for suspected vulnerabilities.

Report security concerns through GitHub private vulnerability reporting:

[Report a vulnerability](https://github.com/CharAznable98/roam-cli/security/advisories/new)

This route requires private vulnerability reporting to be enabled for the repository.

Include:

- Affected component: Server, Runner, Web UI, shared protocol, or agent plugin.
- Steps to reproduce.
- Impact and expected exploit path.
- Any relevant logs, screenshots, or proof-of-concept details.

## Scope

Relevant areas include:

- Runner workspace access boundaries.
- Token handling and setup flow.
- WebSocket authentication and authorization.
- Approval handling and patch application.
- Local file read/write behavior.
- Agent plugin process execution.

## Disclosure

Please give maintainers reasonable time to investigate and prepare a fix before public disclosure.
