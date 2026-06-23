# Design

## Source of truth

- Status: Active
- Last refreshed: 2026-06-23
- Primary product surfaces:
  - RoamCli web shell: project/session navigation, conversation, files, approvals, and the planned Git tab.
  - Server API and runner RPC contracts that route workspace and Git operations to the owning runner.
  - Runner execution model for direct sessions and Git worktree sessions.
- Evidence reviewed:
  - `CONTEXT.md`: Project, Runner, Session, execution folder, direct mode, managed worktree, archive, and project-directory vocabulary.
  - `README.md` / `README_ch.md`: Server + Runner + Web architecture, runner workspace, and Git prerequisite.
  - `docs/adr/0004-project-directories-use-runner-paths.md`: project directories are interpreted from the runner filesystem perspective.
  - `docs/prd-todo-list.md`: current product implementation status and planned Monaco/file editing work.
  - `docs/implementation-plan.md`: shared contracts, server, runner, and web implementation tracks.
  - `packages/shared/src/protocol/index.ts`: current schema and event boundaries.
  - `apps/server/src/modules/workspace/workspace-service.ts`: current HTTP-to-runner workspace RPC pattern.
  - `apps/runner/src/sessions/manager.ts`: current direct and managed worktree execution behavior.
  - `apps/runner/src/bootstrap/cli.ts` and `apps/runner/src/bootstrap/registration.ts`: runner workspace and `.roam-runner` state directory behavior.
  - `apps/web/src/app/AppShell.tsx`, `apps/web/src/app/navigation.ts`, and `apps/web/src/app/BottomTabs.tsx`: current workspace tab model.
  - `apps/web/src/features/sessions/NewSessionForm.tsx`: current direct / managed worktree session creation UI.
  - `apps/web/src/features/files/FilePanel.tsx`: current lightweight file tree and text editor surface.
  - `apps/web/src/features/git/GitPanel.tsx`: current Monaco diff preview surface.
  - `apps/web/src/features/conversation/MarkdownMessage.tsx`: current Markdown rendering implementation and safe raw-HTML boundary.
  - `apps/web/src/App.test.tsx` and `scripts/blackbox-browser.mjs`: current file preview/edit/save and Git diff smoke coverage.
  - `apps/web/src/index.css` and `apps/web/tailwind.config.ts`: responsive shell, restrained operational palette, and component styling.
  - 2026-06-21 Web redesign pass: `apps/web/src/app/AppShell.tsx` and `apps/web/src/index.css` reviewed for shell hierarchy, panel rhythm, mobile touch targets, and operational status visibility.
  - 2026-06-23 file preview optimization design interview: read-only default preview, explicit edit entry, app-level fullscreen, button-driven save state, Markdown read-only rendering, and Git diff edit routing.
  - `packages/agent-claude-code/src/index.ts`: Claude Code SDK system task/status messages are currently summarized as plain assistant messages.
  - `apps/runner/src/sessions/manager.ts`: agent runtime `message` events are translated into persisted `assistantMessage` runner events.
  - `apps/server/src/modules/runners/runner-event-service.ts`: `assistantMessage` events are stored as normal assistant `Message` records.
  - `apps/web/src/features/conversation/model.ts` and `apps/web/src/features/conversation/ChatPanel.tsx`: current conversation display items, intermediate output grouping, and collapsible message rendering.

## Brand

- Personality:
  - Quiet, operational, precise, and developer-focused.
  - The UI should feel like a control surface for real development machines, not a marketing application.
- Trust signals:
  - Explicit operation scope before side effects.
  - Clear Git context labels.
  - Direct Git failure output with copy support.
  - Minimal server-side persistence and runner-local credential usage.
- Avoid:
  - Decorative visual noise.
  - Hidden platform magic.
  - Ambiguous Git actions whose target repo, branch, worktree, or file is unclear.
  - GitHub/GitLab/Bitbucket platform features in the Git tab scope.
  - Marketing-page visual devices in the product shell, including hero copy, decorative image panels, logo walls, and ornamental gradients.

## Product goals

- Goals:
  - Keep agent execution activity visible without polluting the user-readable conversation.
  - Represent Claude Code task/status progress as non-message `AgentActivity` events instead of assistant text.
  - Add a Project-bound Git tab that manages local Git capabilities for the selected Project.
  - Keep all Git, GitLens-like inspection, diff, branch, remote, stash, merge, rebase, and worktree controls inside the Git tab.
  - Support Session creation in two modes: local mode and worktree mode.
  - Make worktree mode create a new branch-backed Git worktree for the session.
  - Provide VS Code-like Source Control and GitLens-like local inspection without implementing provider APIs.
  - Use Monaco as the Git tab file/diff inspection foundation.
  - Store the minimum product data needed for identity, session-worktree association, job audit, and session Git artifacts.
- Non-goals:
  - Do not show provider lifecycle strings such as `Claude Code task progress:` as assistant/user conversation messages.
  - Do not make activity groups the primary approval action surface.
  - No PR, issue, CI, review comment, provider login, or provider token management.
  - No automatic nested repository discovery under the Project directory.
  - No strong preflight blocking for destructive Git actions beyond clear user confirmation.
  - No long-term persistence of full diff, blame, commit graph, file history, stdout, or stderr.
  - No Git credential storage in Server or Web.
- Success signals:
  - Users can see the latest running agent action without the chat transcript turning into a status log.
  - Historical agent activity is available through collapsed groups but does not compete with normal messages.
  - Users can understand which Project/session/worktree the Git tab is operating on.
  - Worktree sessions are branch-backed and can commit, push, and be cleaned up predictably.
  - Diff, blame, history, and commit inspection feel responsive on desktop and usable on mobile.
  - Git actions route through the runner and respect runner filesystem boundaries.
  - A browser refresh or reconnect can recover job status and essential audit state without storing large Git data.

## Personas and jobs

- Primary personas:
  - Developer supervising AI coding sessions in one or more projects.
  - Developer reviewing and committing agent-generated changes.
  - Developer managing branch/worktree isolation for parallel session work.
- User jobs:
  - Create an isolated branch worktree for a new session.
  - Review working tree changes and stage files, hunks, or ranges.
  - Inspect blame, file history, line history, and commit details.
  - Commit staged changes and push/pull/fetch using the runner machine's Git credentials.
  - Archive a session and decide whether to delete its associated worktree.
  - Copy clear Git failure output and paste it to an agent for diagnosis.
- Key contexts of use:
  - Desktop review and commit work with side-by-side diff.
  - Tablet inspection with inline diff and secondary panes.
  - Mobile status/review flows with single-column inline diff.
  - Offline runner states where historical product associations remain visible but live Git data is unavailable.

## Information architecture

- Primary navigation:
  - Add a top-level workspace tab named `Git`.
  - Git capabilities must not be split across Files, Approvals, or Chat.
  - Bottom/mobile navigation adds the same Git tab.
- Conversation activity timeline:
  - Normal conversation messages are only user-visible user and assistant content.
  - `tool`, `thought`, `system`, `approval`, and provider status/progress events are auxiliary activity, not normal message boundaries.
  - Frontend display merges `Message` records and `AgentActivity` records by timestamp.
  - Consecutive auxiliary events between two normal messages collapse into one `activityGroup`.
  - Each `activityGroup` renders immediately above the next normal message.
  - If the latest activity has no following normal message yet, its group renders at the end of the message list.
  - Only the latest `activityGroup` shows the latest short action in its collapsed row.
  - Historical `activityGroup` rows show only `Activity (N)`.
  - When a following normal message appears, the previous latest `activityGroup` automatically becomes historical and collapses.
  - If an `Intermediate output` group collapses a span of non-final output, any `activityGroup` inside that span collapses inside the same intermediate group.
- Git tab top-level structure:
  - Header: Project repo identity, active Git context, selected session context label, branch/upstream/ahead-behind status, dirty count, and sync state.
  - Context selector: Project repository and current Project session worktrees only.
  - Main Git views:
    - `Changes`: Source Control groups, commit box, staging controls, sync status.
    - `History`: commit history, commit graph, file history, line history, blame entry points, commit details.
    - `Branches`: branch, tag, ref, compare, merge, rebase, cherry-pick, revert controls.
    - `Worktrees`: session worktrees, worktree removal, worktree path, branch, base ref, and association to sessions.
    - `Remotes`: remotes, fetch, pull, push, sync, upstream, incoming/outgoing.
    - `Stashes`: stash list, create/apply/pop/drop, stash diff.
  - Detail surface:
    - Monaco diff/file viewer for selected change, commit, blame, history, stash, or compare item.
- Git context rules:
  - Git tab is Project-bound.
  - Local session context is the Project directory repository.
  - Worktree session context is the session-created branch worktree.
  - Switching selected Session automatically switches Git context back to that session's context.
  - There is no pinned context mode.
  - The selected Session context must be visibly marked.
  - Users may temporarily switch to another Project context, but session changes reset the active context.
- Non-Git Project:
  - If Project directory itself is not a Git repo, show a Git empty state with `Initialize Git repository`.
  - Worktree session creation is disabled until the Project has a Git repo and at least one commit.
  - Local session creation remains available.
- Nested repositories:
  - Do not scan subdirectories for nested repos.
  - Do not open submodules as child contexts.
  - Parent repo Git status may show submodule status as a parent repo change.

## Design principles

- Principle 1: Scope is visible before action.
  - Every Git action must show the active context and target branch/file/ref before execution.
- Principle 2: Git is the source of truth.
  - Status, diff, blame, graph, remote, stash, and branch data are queried from Git on demand.
  - Server stores product associations and audit metadata, not a second Git index.
- Principle 3: Runner owns filesystem and Git execution.
  - Web never sends arbitrary paths.
  - Web sends `GitContextRef`; Server resolves it to Project/session identity; Runner executes in the resolved path.
- Principle 4: Isolation is explicit and visible.
  - New sessions default to local/direct mode to match the existing Project default.
  - Worktree mode is explicit when the user wants new-branch isolation.
- Principle 5: Simple default UI, complete advanced surface.
  - Default commit UI stays small.
  - Advanced actions live in menus or contextual actions.
- Principle 6: Activity explains execution, messages carry conversation.
  - Agent lifecycle and tool/task progress must be available as operational context.
  - They must not be persisted as assistant prose or rendered as assistant prose.
  - The visible transcript remains readable without expanding activity groups.
- Tradeoffs:
  - The platform warns before dangerous actions but does not strongly block them.
  - Full command output is copyable for active jobs but not persisted long term.
  - Monaco is heavier than simple diff HTML, but better matches the desired end-state diff and inspection experience.

## Visual language

- Color:
  - Continue the existing muted operational palette from `tailwind.config.ts`: ink neutrals plus signal green/amber/red/cyan.
  - Avoid one-hue surfaces and large decorative gradients.
  - Web shell redesign uses a light operational theme with cool neutral surfaces, one cyan accent, semantic green/amber/red states, and no mid-page theme inversion.
  - Git statuses use concise, consistent signal tones:
    - clean/success: signal green
    - warning/diverged/conflict risk: signal amber
    - destructive/error/conflict: signal red
    - informational/sync/remote: signal cyan
- Typography:
  - Continue system sans-serif with compact operational hierarchy.
  - Use monospace only for code, refs, SHAs, paths, and command output.
  - Prefer system UI over a branded display face; this is a repeated-use control plane, not a landing page.
- Spacing/layout rhythm:
  - Dense but readable. Git views are work surfaces, not marketing panels.
  - Keep fixed toolbar and row heights where possible to prevent diff/status reflow.
  - Desktop shell uses framed work panes with small gutters; mobile keeps full-width panes and bottom navigation.
- Shape/radius/elevation:
  - Match existing restrained 7-8px radius and light panel shadows.
  - Do not nest decorative cards inside cards.
  - Radius system: 8px controls, 10px work panes, full-pill badges only.
- Motion:
  - Use minimal motion for loading/progress only.
  - Respect reduced-motion preference.
- Imagery/iconography:
  - Use lucide icons for toolbar and tab actions where available.
  - Prefer icons for common commands: refresh, stage, unstage, commit, pull, push, branch, tag, history, diff, trash.

## Components

- Existing components to reuse:
  - `AppShell` workspace tab frame.
  - `BottomTabs` mobile navigation pattern.
  - `StatusPill` for compact state indicators.
  - Notification stack for request errors.
  - Form and button patterns from session creation and file editing.
  - Existing `details` / `summary` collapsible-message styling for low-emphasis expandable activity groups.
- New/changed components:
  - `AgentActivityGroup`: collapsed non-message activity segment between normal messages.
  - `AgentActivityItem`: short action row shown only when a group is expanded.
  - `ConversationDisplayItem`: extend the display model to interleave `message`, `activityGroup`, and `intermediateGroup` items.
  - `GitPanel`: root Git tab container.
  - `GitContextHeader`: active context, selected session marker, branch/upstream/sync state.
  - `GitContextSelector`: Project repo and session worktree switcher.
  - `GitChangesView`: grouped status, staging controls, commit box.
  - `GitCommitBox`: message, Stage All, Unstage All, Commit, and overflow menu.
  - `GitDiffViewer`: Monaco wrapper for structured content diff.
  - `GitHistoryView`: paginated history and graph container.
  - `GitBlameOverlay`: Monaco line/range decorations and hover data.
  - `GitWorktreesView`: session worktree list and removal action.
  - `GitJobOutput`: active job failure/output panel with copy button.
  - `GitEmptyState`: non-Git repo init state.
- Variants and states:
  - Agent activity group: latest/running, historical, inside intermediate output.
  - Agent activity kind: status, task_started, task_progress, task_notification, approval, tool, system, thought.
  - Git context: project, selected session local, selected session worktree, other session worktree.
  - Repo state: clean, dirty, conflict, unborn, detached HEAD, remote-diverged, runner-offline.
  - Diff state: loading, ready, too large, binary, read-only, editable current side.
  - Job state: queued, running, succeeded, failed, cancelled.
  - Worktree state: active, archived-session-linked, deleted, unavailable.
- Token/component ownership:
  - Extend existing Tailwind theme and component CSS.
  - Do not introduce a second design-system framework.

## Accessibility

- Target standard:
  - WCAG 2.1 AA for core Git flows.
- Keyboard/focus behavior:
  - Git tab must be keyboard navigable.
  - Changes list supports arrow navigation, Enter to open diff, Space for selection where applicable.
  - Commit message supports normal textarea behavior.
  - Destructive confirmations must trap focus and return focus to the invoking control.
  - Monaco shortcuts must not trap users without visible alternatives.
- Contrast/readability:
  - Status badges and diff line states must not rely on color only.
  - Use icons/text labels for staged, unstaged, conflict, and deleted states.
- Screen-reader semantics:
  - Resource groups use headings and list semantics.
  - Diff viewer has accessible file/path/ref labels.
  - Job progress and failure output use live-region updates where appropriate.
- Reduced motion and sensory considerations:
  - Avoid animated graph effects.
  - Progress indicators should be subtle and non-flashing.

## Responsive behavior

- Supported breakpoints/devices:
  - Mobile: single-column tab flow.
  - Tablet: two-pane where space allows, inline diff default.
  - Desktop: multi-pane Git workbench with side-by-side diff default.
- Layout adaptations:
  - Desktop:
    - Left: Git view navigation and resource lists.
    - Right: Monaco detail/diff surface.
    - Side-by-side diff default.
  - Tablet:
    - Inline diff default.
    - Navigation and detail can stack or collapse.
  - Mobile:
    - Fixed inline diff only.
    - File/change list first, selected item opens a single-detail view.
    - Top controls: back, stage/unstage, next/previous hunk, copy output.
    - No side-by-side toggle.
- Touch/hover differences:
  - Hover blame details must also be available by tap/click.
  - Context menus need accessible button alternatives.
- Monaco behavior:
  - Lazy-load Monaco when entering Git tab or opening a diff.
  - Dispose Monaco models on context/file changes and when leaving the Git tab.
  - Large diff/file handling must avoid loading entire repository diffs into Monaco.

## Interaction states

- Loading:
  - Status refresh shows lightweight inline progress.
  - Long Git operations create a Git job and progress state.
  - Latest agent activity group shows one short current action plus step count.
  - Activity groups never stream as normal message text.
- Empty:
  - No Git repo: show init repo action.
  - Clean working tree: show clean state, branch/upstream, and sync actions.
  - No history for file/query: show scoped empty state.
- Error:
  - Show direct, clear Git failure information.
  - Provide `Copy error` for operation, context, branch/ref/file, exit code, stdout/stderr currently available.
  - Do not persist complete stdout/stderr long term.
- Success:
  - Job success updates status and displays concise completion feedback.
  - When a normal message arrives after activity, the preceding latest group becomes historical and collapses to `Activity (N)`.
- Disabled:
  - Worktree mode disabled for non-Git and unborn repos.
  - Commit disabled when there are no staged changes.
  - Operations disabled while a conflicting write job runs in the same context.
- Offline/slow network:
  - Runner offline keeps Project/Session records visible.
  - Live Git status/diff/history unavailable until runner returns.
  - Existing minimal audit/job state remains visible.
  - Persisted agent activity reloads with session detail after refresh or reconnect.

## Content voice

- Tone:
  - Direct, factual, and operational.
  - Avoid playful or decorative copy.
- Terminology:
  - Use repo, branch, worktree, staged, changes, conflicts, commit, remote, stash.
  - Use Project, Session, Runner, Project directory, execution folder per `CONTEXT.md`.
  - Avoid `workspace` when referring to product Project concepts, except for Runner workspace root.
- Microcopy rules:
  - Before destructive actions, name the object and consequence.
  - Keep confirmations short; no type-to-confirm requirement.
  - Do not over-explain Git errors; show copyable output for agent diagnosis.
  - Agent activity copy is productized into short actions such as `Starting task`, `Exploring file preview component`, `Reading apps/web/src/app/useRoamController.ts`, `Waiting for approval`, and `Task completed`.
  - Do not expose provider prefixes such as `Claude Code status:` or `Claude Code task progress:` in default UI.

## Feature design: File preview optimization

- Default mode:
  - Opening any file starts in read-only preview mode.
  - Editable text files show an `Edit` button in read-only mode.
  - Unsupported files do not show edit or save controls.
  - Editable means runner-returned text content that is not truncated. Filesystem write permission is discovered on save failure, not preflighted in Web.
- Edit mode:
  - Clicking `Edit` switches the current file into source edit mode.
  - Edit mode shows `Cancel` and `Save`.
  - `Save` is visible only in edit mode.
  - `Save` is disabled when content is clean or a save is in progress.
  - `Save` is enabled when the edited buffer differs from the loaded file content.
  - Save success keeps the user in edit mode and disables `Save` until the next change.
  - Save failure keeps the user in edit mode, reports through the existing notification path, and allows retry.
  - `Cancel` exits edit mode. If the buffer is dirty, confirm before discarding changes.
  - Switching files or closing edit/fullscreen while dirty must also confirm before discarding changes.
- Status expression:
  - Remove persistent `Editable`, `Read-only`, `Saved`, and `Unsaved` badges from the file preview header.
  - Express state through button visibility, disabled state, and loading state rather than status copy.
- Markdown files:
  - In read-only mode, `.md` files default to rendered Markdown.
  - Read-only Markdown view provides a rendered/source toggle.
  - The Markdown rendered/source preference is page-session scoped and not persisted; first open after refresh defaults to rendered Markdown.
  - Edit mode for Markdown is always source editing in Monaco, not WYSIWYG editing.
  - Markdown rendering must reuse the safe message-rendering boundary: no raw HTML insertion into the DOM.
- Fullscreen:
  - Fullscreen is an app-level overlay, not the browser Fullscreen API.
  - Fullscreen expands only the current preview/editor/diff surface, not the file tree.
  - Fullscreen retains file name, mode controls, Markdown toggle, `Edit`, `Cancel`, and `Save` where applicable.
  - `Esc` and a visible close control exit fullscreen.
  - Monaco-based views must relayout after entering and exiting fullscreen.
- Git diff preview:
  - Git diff preview remains read-only.
  - Only working tree, unstaged, text, non-binary, non-too-large, non-deleted diffs show `Edit`.
  - Git diff `Edit` opens the same path in the Files panel directly in edit mode.
  - Staged diffs, commit/history diffs, deleted files, binary diffs, and too-large diffs do not show `Edit`.
  - Git diff preview also supports the same app-level fullscreen behavior for the current diff surface.
- Acceptance criteria:
  - Selecting a text file shows read-only preview first, with `Edit` but no `Save`.
  - Clicking `Edit` shows `Cancel` and `Save`; clean content disables `Save`; dirty content enables `Save`.
  - Image, binary, and truncated files never show `Edit` or `Save`.
  - `.md` read-only preview defaults to rendered Markdown and can switch to source preview.
  - `.md` edit mode always opens source editing.
  - Dirty cancel/file switch/fullscreen close prompts before discarding edits.
  - App-level fullscreen works for ordinary file preview/editing and Git diff preview.
  - Working tree eligible diff `Edit` routes to Files edit mode; ineligible diffs have no edit control.

## Implementation constraints

- Framework/styling system:
  - React 19 + Vite + Tailwind.
  - Use existing reducer/controller state pattern before adding a new state library.
  - Use lucide icons for common Git actions.
- Agent activity protocol:
  - Use a generic `AgentActivity` model rather than a Claude Code-specific protocol.
  - First implementation may emit activities only from Claude Code.
  - Persist agent activities separately from `Message` records so they reload with session detail but do not enter conversation history or transcript exports.
  - Suggested minimum fields: `id`, `sessionId`, `agent`, `kind`, `label`, `createdAt`.
  - Frontend must not parse provider-formatted prose to detect activity; runner/plugin code emits structured activity with a productized `label`.
  - Approval requests remain actionable through the existing Approvals surface; activity only records short status such as `Waiting for approval`.
  - WebSocket updates broadcast activity creation separately from `message:created`.
  - Reducer/display tests must cover latest-group live summary, historical collapse, reload persistence, and intermediate output containment.
- Git execution:
  - Runner executes all Git operations.
  - Use `simple-git` for common Git commands and native `git` fallback for advanced commands.
  - Server and Web never store Git CLI credentials.
  - `fetch`, `pull`, `push`, and `sync` use the runner machine's system Git credentials.
  - Provider platform APIs are out of scope.
- Git context addressing:
  - Web sends structured refs only:

```ts
type GitContextRef =
  | { kind: "project"; projectId: string }
  | { kind: "session_worktree"; sessionId: string };
```

- Web must not send arbitrary filesystem paths for Git operations.
- Session creation:
  - New sessions default to local/direct mode.
  - Worktree mode remains explicit.
  - Worktree mode creates a new branch and a worktree.
  - Worktree base ref selector defaults to the Project current branch.
  - Detached HEAD is allowed as a base by resolving and displaying the base SHA.
  - Unborn repos cannot create worktree sessions.
  - Branch names are auto-generated and editable.
  - Default branch name: `roam/<date>-<session-slug>-<short-id>`.
  - Existing branch name collisions are errors; do not overwrite.
- Worktree storage:
  - Reuse current runner-local state pattern.
  - `--data-dir` is relative to the runner workspace root and defaults to `.roam-runner`.
  - Reject absolute paths, `~`, `..`, and normalized escapes.
  - Worktree path: `<runnerWorkspaceRoot>/<dataDir>/worktrees/<projectId>/<sessionId>`.
  - Do not special-case `.roam-runner` if the runner workspace root is also a Git repo.
- Worktree lifecycle:
  - Session and worktree/branch are independent resources.
  - Archiving a session linked to a worktree asks whether to delete the worktree.
  - Deleting a worktree never deletes the branch.
  - Before deleting a worktree, show expectation-setting warning only; do not run dirty/unpushed/merged preflight blockers.
  - Use force removal behavior after user confirmation if needed.
- Git API shape:
  - Lightweight read operations may use request/response RPC.
  - Long or mutating operations use Git jobs with status/progress/result.
  - Writes are serialized per Git context; reads can run concurrently with debounce.
  - Different contexts can run independently.
- Status model:
  - Runner parses porcelain and returns resource groups.
  - Frontend does not parse Git porcelain.
  - Groups include staged, changes, conflicts, untracked, ignored, and submodules.
- Diff model:
  - Expose one canonical diff API: structured content diff for Monaco.
  - Do not expose raw patch as the main protocol.
  - Frontend may derive unified/copy/export text from old/new content.
  - Runner remains responsible for Git semantic operations.
- Staging model:
  - Stage/unstage files, hunks, and selected ranges.
  - Frontend sends selected ranges for line/hunk staging.
  - Runner converts selection into safe Git operations.
- Blame model:
  - Return compressed blame ranges and de-duplicated commit metadata.
- History/graph model:
  - Load commit history/graph incrementally with cursors and filters.
  - Do not fetch or persist full graph data at once.
- Commit UI:
  - Default commit box: message, Stage All, Unstage All, Commit.
  - Commit operates on staged changes only.
  - Advanced options live in overflow menus.
- Dangerous operations:
  - Prompt clearly before discard, clean, reset, force push, and worktree deletion.
  - Do not strongly block after confirmation.
  - Display the exact object/ref/file affected.
- Persistence constraints:
  - Store only:
    - existing Project and Session identity data,
    - session Git branch name,
    - session base ref,
    - session base SHA,
    - worktree deletion timestamp,
    - Git job audit metadata,
    - session Git artifact links such as commit SHA or local Git artifact refs.
  - Do not store:
    - full diff,
    - blame results,
    - commit graph,
    - file history,
    - branch/remote/stash lists,
    - full stdout/stderr,
    - Monaco models,
    - active context UI state.
- Performance constraints:
  - Lazy-load Monaco.
  - Page history/graph.
  - Load diffs per selected file.
  - Add size caps and binary/too-large states.
  - Debounce status refresh.
- Compatibility constraints:
  - System Git is required on the runner.
  - Git LFS and submodule behavior are mediated through system Git.
  - LFS is not separately managed; errors are surfaced from Git.
  - Submodule status can appear in the parent repo, but no child repo context is opened.
- Test/screenshot expectations:
  - Shared protocol tests for Git schemas.
  - Runner tests using temporary Git repos for status, diff, branch worktree, commit, stash, and error handling.
  - Server tests for context resolution, job persistence, runner routing, and minimal persistence.
  - Web reducer/component tests for context switching, status groups, commit box, dangerous confirmations, and responsive Git tab states.
  - Web tests for default read-only file preview, edit/cancel/save button states, dirty discard confirmation, Markdown rendered/source toggle, fullscreen overlay, and Git diff edit routing.
  - Playwright or browser smoke tests for desktop/tablet/mobile Git tab layout once implemented.

## Open questions

- [ ] Confirm whether `Git` tab label should be English-only or localized with the existing mixed Chinese/English mobile labels.
- [ ] Decide whether Git job stdout/stderr copy buffer should survive only while the page is open or also across WebSocket reconnects without DB persistence.
