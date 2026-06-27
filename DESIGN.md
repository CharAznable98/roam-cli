# Design

## Source of truth

- Status: Active
- Last refreshed: 2026-06-27
- Primary product surfaces:
  - RoamCli web control plane for AI coding agent sessions.
  - Desktop three-pane workbench: project/session tree, agent run console, and contextual tools.
  - Mobile workbench with degraded single-surface navigation.
  - Authentication, owner setup, empty states, settings, command palette, and creation/editing flows.
- Evidence reviewed:
  - `README.md`: RoamCli is a self-hosted web control plane for AI coding agents, runners, projects, sessions, files, approvals, and patches.
  - `CONTEXT.md`: canonical product language for Project, Runner, Session, Execution Folder, Managed Worktree, Agent, Task, and rendered messages.
  - `apps/web/package.json`: React 19, Vite, Tailwind, lucide-react, Monaco, dnd-kit, markdown rendering, and no current shadcn/ui dependency.
  - `apps/web/tailwind.config.ts`: existing ink and signal color tokens.
  - `apps/web/src/index.css`: current light operational shell, CSS variables, pane rhythm, settings styles, and responsive behavior.
  - `apps/web/src/app/AppShell.tsx`: current shell composition, settings flow, project/session state, and tool panels.
  - `apps/web/src/app/navigation.ts`: current workspace tabs include Conversation, Files, Git, Approvals, and Settings.
  - `apps/web/src/features/sessions/RunnerSidebar.tsx`: current Project-first project/session tree.
  - `apps/web/src/features/conversation/ChatPanel.tsx`: current conversation, composer, session actions, activity/message surfaces, and prompt tools.
  - `apps/web/src/features/files/FilePanel.tsx`: current file tree/editor tool surface.
  - `apps/web/src/features/git/GitPanel.tsx`: current Git status/diff/history tool surface.
  - `apps/web/src/features/approvals/ApprovalCenter.tsx`: current approval action surface.
  - `apps/web/src/features/approvals/ArtifactList.tsx`: current artifact list exists, but this design removes it as a standalone product entry.
  - User design decisions from 2026-06-27 interview: shadcn/ui, professional control console, light-first theme, three-pane workbench, Project-first tree with Runner filter, Agent Run Console, Files/Git/Approvals tools, Settings Drawer, full first-version Command Palette.

## Brand

- Personality:
  - Professional control console / Developer Cockpit.
  - Quiet, precise, operational, and built for long-running development supervision.
  - Modern and designed, but not decorative, playful, or marketing-led.
- Trust signals:
  - Current Project, Session, Runner, execution folder, Git context, and approval scope are visible before side effects.
  - Running agent state is legible without turning the transcript into a status log.
  - Settings and security actions are clearly separated from session tools.
  - Git remains the preferred source of truth for generated work and code changes.
- Avoid:
  - Native ad hoc UI for common controls once shadcn/ui primitives are available.
  - Large decorative gradients, bokeh/orbs, marketing hero sections, oversized cards, and one-note color palettes.
  - Hiding important operational state behind hover-only controls.
  - Treating Artifacts as a primary navigation concept.
  - Putting global Settings inside the session tool tab set.

## Product goals

- Goals:
  - Introduce a component-library-driven frontend based on shadcn/ui, Radix UI, Tailwind, and lucide-react.
  - Redesign the whole frontend as a cohesive light-first professional console before implementation.
  - Preserve the product's Project -> Session -> Agent execution model while making the shell more refined and easier to scan.
  - Keep the center panel focused on the Agent Run Console.
  - Keep right-side tools focused on Files, Git, and Approvals.
  - Add a complete first-version Command Palette for project/session switching, file search, common actions, and settings access.
  - Move Settings to a global top-right entry that opens a right-side Drawer.
  - Support Runner filtering in the Project-first tree with All runners and single-runner modes.
- Non-goals:
  - No marketing landing page treatment for the product shell.
  - No full IDE clone with unrestricted pane docking in the first redesign.
  - No standalone Artifacts tab or primary Artifacts feature.
  - No dark-theme implementation requirement in the first pass, though tokens must leave room for it.
  - No new animation library for the redesign.
  - No visual dependency that fights Tailwind or the current React/Vite stack.
- Success signals:
  - A first-time user can identify Projects, Sessions, Runner filter, current run state, Files, Git, Approvals, Settings, and Command Palette quickly.
  - A daily user can supervise a running agent and inspect files/Git/approvals without losing context.
  - The interface feels intentionally designed while remaining dense enough for repeated professional use.
  - Settings no longer competes with session tools.
  - Artifact-related data, when relevant, is discoverable through Git, Files, or message context rather than a standalone tab.

## Personas and jobs

- Primary personas:
  - Developer supervising one or more AI coding sessions.
  - Developer reviewing and committing agent-generated changes.
  - Developer managing local and worktree session execution through one or more runners.
  - Developer configuring account, notifications, runner tokens, and project-level behavior.
- User jobs:
  - Filter Projects by All runners or one Runner.
  - Select a Project and Session quickly.
  - Start, stop, resume, and monitor an agent task.
  - Read the user/assistant conversation without operational noise.
  - Expand assistant-run details only when needed.
  - Inspect files, Git changes/history, and approvals in the right tool area.
  - Open Settings without leaving the active session.
  - Use Command Palette to switch context, find files, run common actions, and open settings.
- Key contexts of use:
  - Desktop supervision with three-pane layout.
  - Laptop review with a narrower but still persistent tool panel.
  - Mobile status checks with layout degraded into task-focused tabs/sheets.
  - Offline or unavailable runner states where historical context remains visible and live actions degrade clearly.

## Information architecture

- Primary navigation:
  - Desktop uses a three-pane workbench:
    - Left: Project-first tree and Runner filter.
    - Center: Agent Run Console.
    - Right: session tools.
  - Right-side session tool tabs are `Files`, `Git`, and `Approvals`.
  - `Settings` is not a session tool tab.
  - `Artifacts` is not a session tool tab.
- Left pane:
  - Project-first tree is the primary navigation.
  - Sessions are nested under Projects.
  - Runner is a filter dimension, not the top-level tree dimension.
  - Runner filter lives at the top of the left pane.
  - Runner filter supports `All runners` and a single selected Runner.
  - Use shadcn `Select` initially; upgrade to Command/Combobox when Runner count makes search useful.
- Center pane:
  - The center pane is the Agent Run Console, not a generic chat app.
  - It contains compact session context, running state, message stream, assistant activity affordances, and composer.
  - Assistant run activity is attached under each assistant message as a collapsible area.
  - All activity groups are collapsed by default.
  - While a run is active, show only the latest activity item for the current assistant turn.
  - Historical activity stays accessible but visually quiet.
- Right pane:
  - Fixed role as contextual tools for the active Project/Session.
  - Primary tabs: `Files`, `Git`, `Approvals`.
  - Use badges for counts/status, such as changed files and pending approvals.
  - Right pane is width-adjustable on desktop.
- Settings:
  - Top-right global Settings menu is the primary entry.
  - Project row overflow menu may deep-link to Project Settings.
  - Settings opens in a right-side shadcn Sheet/Drawer.
  - Global settings include account/security, notifications, runner token/security, and logout.
  - Project Settings includes project-scoped settings such as prompt presets.
- Creation and editing flows:
  - Short flows, such as New Project and New Session, use focused Dialogs.
  - Longer flows, such as prompt preset management and settings detail pages, use Sheets/Drawers.
- Command Palette:
  - First version is fully designed and implemented as a core console affordance.
  - Top bar contains a compact command trigger.
  - Keyboard shortcut: Cmd+K on macOS, Ctrl+K elsewhere.
  - Supports project/session switching, file search, common actions, and settings entry.
  - Mobile keeps a search/command button without showing shortcut hints.
- Authentication, owner setup, and empty states:
  - Included in the same design system.
  - Use light, focused, narrow forms.
  - Do not use marketing hero layouts.

## Design principles

- Principle 1: Work context stays visible.
  - Current Project, Session, Runner filter, run status, and active tool should be visible without modal hunting.
- Principle 2: Git is the useful artifact surface.
  - Generated code and patches should be inspected through Git and Files.
  - Do not add a primary Artifacts area unless future non-Git outputs become a real user job.
- Principle 3: Conversation stays readable.
  - User and assistant prose should remain the main transcript.
  - Tool calls, command output, status events, and approvals are operational context and should be collapsible.
- Principle 4: Tools belong to the right pane; settings do not.
  - Files, Git, and Approvals are current-session tools.
  - Account, security, notifications, and project configuration are global or management concerns and open through Settings Drawer.
- Principle 5: Component library first.
  - Prefer shadcn/ui primitives and variants over ad hoc HTML/CSS for buttons, menus, dialogs, sheets, tabs, forms, toasts, command palette, tooltips, and resizable panels.
- Principle 6: Dense but breathable.
  - Preserve high information density while using consistent spacing, hierarchy, and component states to avoid visual fatigue.
- Tradeoffs:
  - shadcn/ui provides ownership and visual flexibility, but the team owns local component quality and consistency.
  - A complete Command Palette increases first-pass complexity, but it is appropriate for a professional console.
  - Dark theme is token-aware but not part of the initial implementation acceptance.

## Visual language

- Color:
  - Light-first theme.
  - Backgrounds use cool neutral gray-blue surfaces.
  - Primary accent uses blue-cyan, extending the existing cyan direction.
  - Semantic states use green, amber, red, and cyan consistently.
  - Avoid broad purple/blue AI gradients and decorative one-hue themes.
- Typography:
  - System sans-serif for product UI.
  - Monospace only for paths, commands, SHAs, refs, logs, code, and terminal-like output.
  - Use compact hierarchy; reserve large display text for empty/login/setup pages only when needed.
- Spacing/layout rhythm:
  - High-density but breathable.
  - Prefer 8px-based spacing.
  - Keep toolbar, row, tab, and badge heights stable.
  - Avoid nested cards; repeated list items may use card-like surfaces only when they represent independent objects.
- Shape/radius/elevation:
  - Controls: 8px radius.
  - Work panes: 8-10px radius.
  - Badges/pills may be full radius.
  - Elevation is subtle and functional; Drawer/Dialog elevation may be stronger than panes.
- Motion:
  - Restrained micro-interactions only.
  - 120-180ms transitions for Drawer/Dialog, dropdowns, command palette, hover/focus, and expand/collapse.
  - Respect reduced-motion preferences.
  - Do not add an animation library for the first redesign.
- Imagery/iconography:
  - Use lucide-react icons through shadcn-compatible components.
  - Use familiar icons for tool tabs, command trigger, settings, runner state, project/session actions, Git actions, approvals, upload, send, stop, resume, copy, refresh, and overflow menus.
  - No decorative illustrations are required for the workbench.

## Components

- Existing components to reuse or migrate:
  - `AppShell` as shell orchestration, while changing the IA.
  - `RunnerSidebar` as the Project-first tree foundation.
  - `ChatPanel` as the Agent Run Console foundation.
  - `PromptComposer` for active and new-session prompts.
  - `FilePanel`, `GitPanel`, and `ApprovalCenter` as right-pane tool foundations.
  - `StatusPill` behavior can inform shadcn Badge variants.
  - Existing notification behavior can inform shadcn Toast usage.
- New/changed components:
  - `ui/*` shadcn component layer: Button, Badge, Card where justified, Dialog, Sheet, DropdownMenu, Select, Command, Tabs, Tooltip, Toast/Sonner equivalent, Input, Textarea, Label, Separator, ScrollArea, Resizable, Skeleton, Alert.
  - `RunnerFilterSelect`: All runners / single runner filter.
  - `CommandPalette`: global command center with grouped results/actions.
  - `TopBar`: context summary, command trigger, global status, settings/account menu.
  - `SettingsDrawer`: global settings shell and detail routes.
  - `ProjectTree`: shadcn-styled Project-first tree with overflow menus.
  - `AgentRunHeader`: compact current session and run state.
  - `AssistantActivityDisclosure`: collapsed assistant-run details under assistant messages.
  - `ToolTabs`: Files/Git/Approvals tab surface with badges.
- Removed or demoted components:
  - Standalone `ArtifactList` should not appear as a primary tab.
  - Existing Settings workspace tab should be replaced by the global menu + Drawer model.
- Variants and states:
  - Buttons: primary, secondary, ghost, destructive, icon-only, compact.
  - Badges: neutral, success, warning, error, info, count.
  - Panels: active, inactive, loading, unavailable/offline, empty, error.
  - Activity disclosure: collapsed historical, collapsed active with latest item, expanded.
  - Runner filter: all, selected runner, offline runner, no runners.
- Token/component ownership:
  - Tailwind tokens remain the source for colors, spacing, radius, and elevation.
  - shadcn components should be themed through CSS variables and Tailwind config.
  - New components should live under the existing frontend component organization and avoid introducing a second styling system.

## Accessibility

- Target standard:
  - WCAG 2.2 AA for core flows.
- Keyboard/focus behavior:
  - Command Palette opens with Cmd+K/Ctrl+K and traps focus while open.
  - Dialogs and Drawers trap focus and restore focus on close.
  - Project tree, tabs, menus, selects, and disclosures are keyboard reachable.
  - Icon-only controls must have accessible names and tooltips where needed.
- Contrast/readability:
  - Text, badges, borders, and selected states must meet contrast expectations on light gray-blue surfaces.
  - Status colors must not rely on color alone.
- Screen-reader semantics:
  - Use semantic regions for left navigation, main Agent Run Console, right tools, and Settings Drawer.
  - Activity disclosures should expose expanded/collapsed state.
  - Counts and pending states should have readable labels.
- Reduced motion and sensory considerations:
  - Respect `prefers-reduced-motion`.
  - Avoid flashing, pulsing, or attention-grabbing decorative motion.

## Responsive behavior

- Supported breakpoints/devices:
  - Desktop is the primary design target.
  - Tablet and mobile remain functionally complete through layout degradation.
- Desktop:
  - Left pane is narrow and stable.
  - Center pane is flexible and primary.
  - Right tool pane is resizable.
  - Top bar contains context, command trigger, global status, and settings/account menu.
- Mobile:
  - Do not compress three panes side by side.
  - Use bottom or top task switching for Chat, Files, Git, and Approvals.
  - Project/session navigation opens in a Sheet.
  - Settings opens in a full-height Sheet/Drawer.
  - Command entry is button-first; shortcut hint is hidden.
- Touch/hover differences:
  - Do not rely on hover to reveal essential actions.
  - Overflow menus and disclosure controls must be touch-sized.

## Interaction states

- Loading:
  - Use Skeletons for panels and lists.
  - Use inline spinners only for local actions.
  - Preserve layout dimensions while loading.
- Empty:
  - No projects: guide the user to create/import a Project.
  - No sessions: prompt for New Session within the selected Project.
  - No files/Git/approvals: show compact, task-specific empty states.
  - No Git repo: Git panel should offer repository initialization where supported.
- Error:
  - Show the failed operation, target context, and recovery action.
  - Git and runner errors should expose copyable technical output when useful.
- Success:
  - Use restrained toast/status feedback.
  - Do not interrupt the user's workspace for routine success states.
- Disabled:
  - Disabled actions must explain the missing prerequisite through tooltip or inline copy.
- Offline/slow network:
  - Offline Runner state should keep historical Project/Session data visible.
  - Live filesystem, Git, and new session actions degrade clearly.

## Content voice

- Tone:
  - Direct, operational, concise.
  - Prefer concrete labels over playful copy.
- Terminology:
  - Use `Project`, `Runner`, `Session`, `Execution Folder`, `Managed Worktree`, `Agent`, `Task`, `Files`, `Git`, `Approvals`, and `Settings` consistently with `CONTEXT.md`.
  - Avoid `workspace` as the user-facing primary navigation dimension when `Project` is meant.
  - Avoid `Artifacts` as primary IA terminology.
- Microcopy rules:
  - Action labels should name the operation and target where needed.
  - Empty states should tell users what is missing and the next action.
  - Dangerous actions should name the scope and consequence.

## Implementation constraints

- Framework/styling system:
  - React 19, Vite, TypeScript, Tailwind.
  - Introduce shadcn/ui with Radix UI primitives and lucide-react icons.
  - Keep Tailwind as the styling foundation.
- Design-token constraints:
  - Define light-first CSS variables for background, foreground, muted, accent, border, ring, destructive, success, warning, info, radius, and elevation.
  - Prepare dark theme variables but do not require dark theme completion in the first pass.
  - Preserve existing semantic signal intent from `tailwind.config.ts`.
- Performance constraints:
  - Keep Monaco-loaded surfaces lazy or scoped to panels that need them.
  - Command Palette search must remain responsive on normal project/session/file counts.
  - Avoid layout shifts in panes, toolbars, tabs, rows, and command results.
- Compatibility constraints:
  - Do not break existing runner/server contracts while redesigning UI surfaces.
  - Component migration should be incremental and testable.
  - Avoid adding dependencies beyond those needed for shadcn/Radix unless explicitly justified.
- Test/screenshot expectations:
  - Update unit/component tests for IA changes, especially Settings removal from workspace tabs and Runner filtering.
  - Add tests for Command Palette opening, keyboard shortcut, search groups, and action dispatch.
  - Add tests for assistant activity collapse/default-active behavior.
  - Run `pnpm --filter @roamcli/web typecheck` and targeted tests after implementation.
  - For frontend implementation, verify desktop and mobile screenshots with Browser/Playwright before completion.

## Open questions

- [ ] Exact shadcn installation strategy and component list should be finalized during implementation after checking current official shadcn/ui docs.
- [ ] Whether Settings Drawer uses internal detail routing or nested views inside one component needs implementation design.
- [ ] Command Palette action list should be enumerated from current supported operations before coding.
- [ ] Whether dark mode is scheduled for a later milestone or only token-prepared remains a product decision.
