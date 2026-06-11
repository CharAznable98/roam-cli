# Project directories use runner paths

A project belongs to one runner, and its project directory is interpreted from that runner's filesystem perspective. This avoids ambiguous path translation between server and runner machines; sessions created under the project use the project's runner and run in that runner-visible directory or in a managed worktree created from it.
