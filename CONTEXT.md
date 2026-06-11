# RoamCli Context

RoamCli is a remote agent control context for coordinating development-machine runners, explicit projects, agent sessions, execution folders, and the conversation records produced while those sessions run.

## Language

**Project**:
A top-level code context that groups related work for one runner. A project belongs to exactly one runner and has exactly one primary project directory in that runner's filesystem.
_Avoid_: Working directory, cwd, folder

**Explicit Project**:
A project created or imported by the user. Directories discovered on a runner are not projects until the user explicitly creates or imports them.
_Avoid_: Auto-discovered project, inferred project

**Project ID**:
A stable identity for a project that is independent of the project's directory path. Sessions and project history belong to the project ID, not to the path string.
_Avoid_: Path ID, directory ID

**Project Name**:
A user-facing display label for a project. Project names may be duplicated and do not define project identity.
_Avoid_: Project key, unique name

**Project Directory Reuse**:
The same runner and directory path may be used by more than one project. Projects remain distinct through their project IDs even when their project directories are identical.
_Avoid_: Directory uniqueness, path uniqueness

**Project State**:
The product state attached to one project, including its sessions, preferences, display name, and lifecycle state. Projects that reuse the same directory share only the physical file contents, not project state.
_Avoid_: Directory state, shared history

**Runner**:
A development-machine participant and execution provider that owns the filesystem perspective for its projects. A project belongs to one runner, and that runner is the default execution provider for the project's sessions.
_Avoid_: Worker, client machine, path translator

**Runner Capability**:
An agent option supported by a runner. The default agent for a new session comes from the project runner's capabilities, using the first available capability unless runner settings later define another default.
_Avoid_: Project agent, session preset

**Project Runner Assignment**:
The immutable association between a project and its runner. Changing runners means creating a different project.
_Avoid_: Runner switch, project migration

**Offline Runner**:
A runner state where the runner assigned to a project is unavailable. The project and its historical sessions remain visible, but new sessions and filesystem actions for that project are unavailable until the runner returns.
_Avoid_: Missing project, deleted runner

**Archive**:
A reversible lifecycle state that hides a project or session from default active views. Archiving a project also archives its sessions; restoring the project makes those sessions visible again. Archiving does not modify project directories, managed worktrees, or other filesystem contents.
_Avoid_: Delete, remove

**Session Archive**:
A reversible lifecycle state for a single session. A session may be archived independently of its project; restoring a project only restores sessions hidden by the project archive, not sessions the user archived separately.
_Avoid_: Session delete, remove from project

**Project Dimension**:
The top-level navigation and grouping dimension for the product. Session lists are filtered or grouped by project, while execution modes and execution folders are shown as session attributes.
_Avoid_: Workspace dimension, folder dimension

**Project Activity**:
The recency signal used to order projects and choose the default active project. Active projects are shown by recent activity, and the default selection is the most recently active unarchived project.
_Avoid_: Alphabetical default, path order

**Project Empty State**:
The product state shown when no projects exist. Users are guided to create or import a project before creating sessions.
_Avoid_: Cwd-first session creation, anonymous session

**Project Directory**:
The primary filesystem folder associated with a project, expressed from the project's runner perspective. A project directory is the stable folder from which normal sessions run and temporary worktrees may be created; it must exist for that runner when the project is created.
_Avoid_: cwd, working directory, session directory

**Project Directory Change**:
A change to the directory path associated with a project. Changing the project directory does not change the project ID or move existing sessions to another project.
_Avoid_: Project rename, session migration

**New Project Directory**:
A directory created during the project creation flow before the project is saved. Once created, it becomes the project's project directory.
_Avoid_: Missing directory, virtual project

**Session**:
A user-visible conversation and execution workspace within one project. Every session belongs to exactly one project, uses that project's runner, and that project assignment does not change. A session can contain many messages, but its agent work is serial.
_Avoid_: Task, run, chat, thread

**Execution Folder**:
The concrete folder where a session runs. The execution folder is recorded as a path string and is either the project directory or a managed worktree created for that session; it is not a file-content snapshot.
_Avoid_: Workspace, working directory, cwd

**Unavailable Execution Folder**:
A historical session state where the folder needed to inspect files no longer exists or is no longer reachable. The session history remains readable, but file browsing or file actions for that session must degrade instead of assuming the folder still exists.
_Avoid_: Missing session, deleted project

**Execution Mode**:
The way a session is run for a project. A session may run directly in the project directory, in a managed worktree, or in a remote environment.
_Avoid_: Session type, runner type

**Direct Mode**:
The default execution mode where a session runs in the project's directory. Multiple sessions in the same project may use direct mode at the same time and therefore share the same files.
_Avoid_: Isolated mode, workspace mode

**Managed Worktree**:
A temporary Git worktree created from a project's directory and used as an isolated execution folder for a session. A managed worktree belongs to a session, not to the project list, and does not change the session's project assignment.
_Avoid_: Project, project directory, folder copy

**Permanent Worktree**:
A long-lived Git worktree that is promoted into its own project. A permanent worktree has its own project directory and can host multiple sessions.
_Avoid_: Temporary worktree, managed worktree

**Agent**:
The coding assistant process started by a runner for a session. A session has one active agent execution path, and that path runs tasks serially.
_Avoid_: Runner, task

**Task**:
The current unit of agent work being executed by a runner-started agent for a session. A session does not run multiple tasks concurrently.
_Avoid_: Message status, session status

**Task status**:
The execution state of a runner's current task, such as running or finished. Because a session's agent work is serial, the session status can represent the current task status in the MVP.
_Avoid_: Message status, output block status

**Agent message**:
A discrete message produced by an agent and shown in the session conversation. Its boundary is one complete assistant message recognized by the agent parser; multiple complete agent returns are multiple agent messages, while one complete return stays in one rendered message.
_Avoid_: Single combined output, output block

**Rendered message**:
The visual rendering of one agent message or user message in the conversation. Agent messages may use full Markdown formatting inside themselves, while user messages are shown as written without Markdown interpretation.
_Avoid_: Message chunk, output block

**Code highlighting**:
The syntax coloring used inside rendered message code blocks. RoamCli prefers high-fidelity editor-like highlighting for coding-agent output.
_Avoid_: Plain code rendering

**Artifact preview**:
A separate preview surface for rich or executable content produced by an agent, such as HTML documents. Artifact previews are distinct from rendered message bodies.
_Avoid_: Raw message HTML, inline HTML rendering

**Token stream**:
A transient Markdown-rendered preview of agent output that has not yet been resolved into a complete agent message. A token stream is not the durable conversation record when a complete agent message boundary is available.
_Avoid_: Agent message, persisted answer

## Example Dialogue

Developer: "Where should this new session run?"

Domain expert: "Choose a project first, then choose whether the session should run directly in the project directory or in an isolated managed worktree."

Developer: "Can the user type a different working directory for the session?"

Domain expert: "No. If they need a different stable folder boundary, they should create or select a different project."

Developer: "If the session runs in a Git worktree, is that a different project?"

Domain expert: "Only if it is promoted into a permanent project. A managed worktree is just the isolated execution folder for that session."

Developer: "The runner is still executing the task, but it has already produced one agent message."

Domain expert: "Show the task status as running, and keep the completed agent message as its own conversation item."

Developer: "If the agent later returns another answer, should it append to the previous message?"

Domain expert: "No. Treat that later return as a separate agent message when it is a separate agent output."

Developer: "If one agent message contains multiple Markdown sections, should those sections become multiple messages?"

Domain expert: "No. Render the Markdown inside the single agent message."

Developer: "If the parser recognizes a complete agent message, should it be stored as token stream history?"

Domain expert: "No. Store it as an agent message; use token streams only for transient preview when a complete message boundary is unavailable."

Developer: "Should an in-progress token stream render Markdown?"

Domain expert: "Yes, but only as a transient preview before the complete agent message is recorded."

Developer: "If an agent returns HTML, should the message body render it directly?"

Domain expert: "No. Treat HTML as artifact preview content, not as message body DOM."

Developer: "Should user messages render Markdown?"

Domain expert: "No. Show user messages as written."
