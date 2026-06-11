# RoamCli

RoamCli is a remote agent control context for coordinating development-machine runners, agent tasks, and the conversation records produced while those tasks run.

## Language

**Runner**:
A development-machine participant that can execute agent tasks for sessions.
_Avoid_: Worker, client machine

**Session**:
A user-visible conversation workspace hosted by one runner-started agent. A session can contain many messages, but its agent work is serial.
_Avoid_: Chat, thread, task

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
