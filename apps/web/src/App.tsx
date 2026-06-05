import type { AgentKind, Approval, Artifact, FileNode, PatchHunk, RunnerRegistration, ServerEvent, Session } from "@roamcli/protocol";
import { Bell, Files, MessageSquare, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApprovalCenter } from "./components/ApprovalCenter";
import { BottomTabs } from "./components/BottomTabs";
import { ChatPanel } from "./components/ChatPanel";
import { FilePanel } from "./components/FilePanel";
import { NewSessionForm } from "./components/NewSessionForm";
import { PushSettings } from "./components/PushSettings";
import { RunnerSidebar } from "./components/RunnerSidebar";
import { TerminalPanel } from "./components/TerminalPanel";
import { createRoamApiClient, sendStreamCommand, type RoamApiClient } from "./lib/api";
import type { UiMessage, WorkspaceTab } from "./types";

const workspaceTabs: Array<{ id: WorkspaceTab; label: string; icon: typeof MessageSquare }> = [
  { id: "chat", label: "Conversation", icon: MessageSquare },
  { id: "files", label: "Files", icon: Files },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "approvals", label: "Approvals", icon: Bell }
];

type AsyncState = "idle" | "loading" | "ready" | "error";

export function App() {
  const [token, setToken] = useState(() => localStorage.getItem("roamcli.token") ?? "dev-token");
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("chat");
  const [runners, setRunners] = useState<RunnerRegistration[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [hunks, setHunks] = useState<PatchHunk[]>([]);
  const [filesBySession, setFilesBySession] = useState<Record<string, FileNode[]>>({});
  const [fileTreeState, setFileTreeState] = useState<Record<string, AsyncState>>({});
  const [selectedFilePath, setSelectedFilePath] = useState("");
  const [fileContent, setFileContent] = useState<{ path: string; content: string; truncated: boolean; encoding: string } | undefined>();
  const [editorContent, setEditorContent] = useState("");
  const [fileContentState, setFileContentState] = useState<AsyncState>("idle");
  const [fileSaveState, setFileSaveState] = useState<AsyncState>("idle");
  const [terminalLines, setTerminalLines] = useState<Record<string, string[]>>({});
  const [patchApplyState, setPatchApplyState] = useState<AsyncState>("idle");
  const [selectedRunnerId, setSelectedRunnerId] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState("");
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [connectionState, setConnectionState] = useState<"open" | "closed" | "error">("closed");
  const [error, setError] = useState<string | undefined>();
  const apiRef = useRef<RoamApiClient | undefined>(undefined);
  const streamRef = useRef<WebSocket | undefined>(undefined);

  useEffect(() => {
    localStorage.setItem("roamcli.token", token);
    setLoadState("loading");
    setError(undefined);
    const api = createRoamApiClient({ token });
    apiRef.current = api;
    let cancelled = false;

    api
      .loadInitialState()
      .then((state) => {
        if (cancelled) return;
        setRunners(state.runners);
        setSessions(state.sessions);
        setMessages(state.messages);
        setApprovals(state.approvals);
        setArtifacts(state.artifacts);
        setHunks(extractPatchHunks(state.approvals));
        setSelectedRunnerId((current) => current || state.runners[0]?.runnerId || "");
        setSelectedSessionId((current) => current || state.sessions[0]?.id || "");
        setLoadState("ready");
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setLoadState("error");
      });

    const socket = api.connectStream((event) => applyServerEvent(event), setConnectionState);
    streamRef.current = socket;

    return () => {
      cancelled = true;
      socket?.close();
    };
  }, [token]);

  const selectedRunner = runners.find((runner) => runner.runnerId === selectedRunnerId) ?? runners[0];
  const runnerSessions = useMemo(
    () => sessions.filter((session) => session.runnerId === selectedRunner?.runnerId),
    [selectedRunner?.runnerId, sessions]
  );
  const selectedSession = sessions.find((session) => session.id === selectedSessionId) ?? runnerSessions[0] ?? sessions[0];
  const sessionMessages = selectedSession ? messages.filter((message) => message.sessionId === selectedSession.id) : [];
  const sessionApprovals = selectedSession ? approvals.filter((approval) => approval.sessionId === selectedSession.id) : approvals;
  const sessionTerminalLines = selectedSession ? (terminalLines[selectedSession.id] ?? []) : [];
  const sessionFiles = selectedSession ? (filesBySession[selectedSession.id] ?? []) : [];
  const sessionFileTreeState = selectedSession ? (fileTreeState[selectedSession.id] ?? "idle") : "idle";

  useEffect(() => {
    if (!selectedSession || !apiRef.current) {
      setSelectedFilePath("");
      setFileContent(undefined);
      setEditorContent("");
      setFileContentState("idle");
      setFileSaveState("idle");
      return;
    }

    const sessionId = selectedSession.id;
    let cancelled = false;
    setSelectedFilePath("");
    setFileContent(undefined);
    setEditorContent("");
    setFileContentState("idle");
    setFileSaveState("idle");
    setFileTreeState((current) => ({ ...current, [sessionId]: "loading" }));

    void apiRef.current
      .fetchFileTree(sessionId)
      .then((fileTree) => {
        if (cancelled) return;
        setFilesBySession((current) => ({ ...current, [sessionId]: fileTree }));
        setFileTreeState((current) => ({ ...current, [sessionId]: "ready" }));
      })
      .catch((fileError: unknown) => {
        if (cancelled) return;
        setFileTreeState((current) => ({ ...current, [sessionId]: "error" }));
        setError(fileError instanceof Error ? fileError.message : String(fileError));
      });

    return () => {
      cancelled = true;
    };
  }, [selectedSession?.id]);

  const selectRunner = (runnerId: string) => {
    setSelectedRunnerId(runnerId);
    const nextSession = sessions.find((session) => session.runnerId === runnerId);
    setSelectedSessionId(nextSession?.id ?? "");
  };

  const createSession = (values: { title: string; cwd: string; prompt: string; agent: AgentKind }) => {
    if (!selectedRunner || !apiRef.current) return;
    void apiRef.current
      .createSession({ runnerId: selectedRunner.runnerId, ...values })
      .then((session) => {
        upsertSession(session);
        setSelectedSessionId(session.id);
        setActiveTab("chat");
      })
      .catch((createError: unknown) => setError(createError instanceof Error ? createError.message : String(createError)));
  };

  const sendMessage = (content: string) => {
    if (!selectedSession) return;
    const sent = sendStreamCommand(streamRef.current, {
      type: "userMessage",
      requestId: `req-${Date.now()}`,
      sessionId: selectedSession.id,
      content
    });
    if (!sent) {
      setError("The event stream is not connected; message was not sent.");
    }
  };

  const resolveApproval = (approvalId: string, approved: boolean) => {
    void apiRef.current
      ?.resolveApproval(approvalId, approved)
      .then((approval) => upsertApproval(approval))
      .catch((approvalError: unknown) => setError(approvalError instanceof Error ? approvalError.message : String(approvalError)));
  };

  const resolveHunk = (hunkId: string, status: "accepted" | "rejected") => {
    setHunks((current) => current.map((hunk) => (hunk.id === hunkId ? { ...hunk, status } : hunk)));
  };

  const applyAcceptedPatch = () => {
    if (!selectedSession || !apiRef.current) return;
    const sessionId = selectedSession.id;
    const openPath = selectedFilePath;
    const patch = buildPatchFromHunks(hunks.filter((hunk) => hunk.status === "accepted"));
    if (!patch) {
      setError("No accepted patch hunks are ready to apply.");
      return;
    }
    setPatchApplyState("loading");
    void apiRef.current
      .applyPatch(sessionId, patch)
      .then((result) => {
        setHunks((current) => current.map((hunk) => (hunk.status === "accepted" ? { ...hunk, status: result.applied ? "edited" : "pending" } : hunk)));
        setPatchApplyState("ready");
        if (!result.applied) {
          setError(result.message);
        }
        if (openPath) {
          loadFileContent(sessionId, openPath);
        }
      })
      .catch((patchError: unknown) => {
        setPatchApplyState("error");
        setError(patchError instanceof Error ? patchError.message : String(patchError));
      });
  };

  const sendControl = (signal: "interrupt" | "stop" | "resume") => {
    if (!selectedSession) return;
    const sent = sendStreamCommand(streamRef.current, {
      type: "controlSignal",
      requestId: `req-${Date.now()}`,
      sessionId: selectedSession.id,
      signal
    });
    if (!sent) {
      setError("The event stream is not connected; control signal was not sent.");
    }
  };

  const sendTerminalCommand = (command: string) => {
    if (!selectedSession) return;
    const sent = sendStreamCommand(streamRef.current, {
      type: "userMessage",
      requestId: `req-${Date.now()}`,
      sessionId: selectedSession.id,
      content: command
    });
    if (!sent) {
      setError("The event stream is not connected; terminal input was not sent.");
    }
  };

  const selectFile = (path: string) => {
    if (!selectedSession || !apiRef.current) return;
    loadFileContent(selectedSession.id, path);
  };

  const saveSelectedFile = () => {
    if (!selectedSession || !selectedFilePath || !apiRef.current) return;
    const sessionId = selectedSession.id;
    const path = selectedFilePath;
    setFileSaveState("loading");
    void apiRef.current
      .saveFileContent(sessionId, path, editorContent)
      .then(() => {
        setFileSaveState("ready");
        loadFileContent(sessionId, path);
      })
      .catch((saveError: unknown) => {
        setFileSaveState("error");
        setError(saveError instanceof Error ? saveError.message : String(saveError));
      });
  };

  const loadFileContent = (sessionId: string, path: string) => {
    if (!apiRef.current) return;
    setSelectedFilePath(path);
    setFileContent(undefined);
    setEditorContent("");
    setFileContentState("loading");
    setFileSaveState("idle");
    void apiRef.current
      .fetchFileContent(sessionId, path)
      .then((result) => {
        setFileContent(result);
        setEditorContent(result.content);
        setFileContentState("ready");
      })
      .catch((fileError: unknown) => {
        setFileContentState("error");
        setError(fileError instanceof Error ? fileError.message : String(fileError));
      });
  };

  function applyServerEvent(event: ServerEvent) {
    if (event.type === "runner:online") {
      setRunners((current) => upsertBy(current, event.runner, (runner) => runner.runnerId));
      setSelectedRunnerId((current) => current || event.runner.runnerId);
      return;
    }
    if (event.type === "runner:offline") {
      setRunners((current) => current.filter((runner) => runner.runnerId !== event.runnerId));
      return;
    }
    if (event.type === "session:created" || event.type === "session:updated") {
      upsertSession(event.session);
      setSelectedSessionId((current) => current || event.session.id);
      return;
    }
    if (event.type === "message:created") {
      setMessages((current) => upsertBy(current, event.message, (message) => message.id));
      return;
    }
    if (event.type === "token") {
      appendTokenMessage(event.sessionId, event.content);
      return;
    }
    if (event.type === "terminal:data") {
      setTerminalLines((current) => ({
        ...current,
        [event.sessionId]: [...(current[event.sessionId] ?? []), stripAnsi(event.chunk)].slice(-1000)
      }));
      return;
    }
    if (event.type === "approval:requested" || event.type === "approval:updated") {
      upsertApproval(event.approval);
      setHunks((current) => mergePatchHunks(current, extractPatchHunks([event.approval])));
      return;
    }
    if (event.type === "artifact:created") {
      setArtifacts((current) => upsertBy(current, event.artifact, (artifact) => artifact.id));
      return;
    }
    if (event.type === "file:tree") {
      setFilesBySession((current) => ({
        ...current,
        [event.result.sessionId]: event.result.root.children ?? [event.result.root]
      }));
      setFileTreeState((current) => ({ ...current, [event.result.sessionId]: "ready" }));
      return;
    }
    if (event.type === "file:content") {
      if (event.result.sessionId === selectedSession?.id && event.result.path === selectedFilePath) {
        setFileContent(event.result);
        setEditorContent(event.result.content);
        setFileContentState("ready");
      }
      return;
    }
    if (event.type === "file:written") {
      if (event.result.sessionId === selectedSession?.id && event.result.path === selectedFilePath) {
        setFileSaveState("ready");
      }
      return;
    }
    if (event.type === "patch:applied") {
      setPatchApplyState(event.result.applied ? "ready" : "error");
      if (!event.result.applied) {
        setError(event.result.message);
      }
      return;
    }
    if (event.type === "error") {
      setError(event.message);
    }
  }

  function upsertSession(session: Session) {
    setSessions((current) => upsertBy(current, session, (item) => item.id));
  }

  function upsertApproval(approval: Approval) {
    setApprovals((current) => upsertBy(current, approval, (item) => item.id));
  }

  function appendTokenMessage(sessionId: string, content: string) {
    setMessages((current) => {
      const id = `stream-${sessionId}`;
      const existing = current.find((message) => message.id === id);
      if (existing) {
        return current.map((message) => (message.id === id ? { ...message, content: message.content + content } : message));
      }
      return [
        ...current,
        {
          id,
          sessionId,
          role: "assistant",
          content,
          encrypted: false,
          createdAt: new Date().toISOString()
        }
      ];
    });
  }

  return (
    <div className={`app-shell active-${activeTab}`}>
      <header className="topbar">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase text-ink-500">RoamCli</p>
          <h1 className="truncate text-lg font-semibold text-ink-900">Remote Agent Control</h1>
        </div>
        <div className="topbar-actions">
          <span className={`rounded px-2 py-1 text-xs font-medium ${connectionState === "open" ? "bg-emerald-50 text-signal-green" : "bg-amber-50 text-signal-amber"}`}>
            {connectionState === "open" ? "stream connected" : "stream disconnected"}
          </span>
          <label className="token-field">
            <span>Token</span>
            <input value={token} onChange={(event) => setToken(event.target.value)} aria-label="API token" />
          </label>
          <span className="rounded bg-emerald-50 px-2 py-1 text-xs font-medium text-signal-green">{runners.length} runners online</span>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      {loadState === "loading" ? <div className="empty-state">Loading remote RoamCli state...</div> : null}

      {loadState !== "loading" && runners.length === 0 ? (
        <div className="empty-state">
          No runners are connected. Start one with:
          <pre>pnpm --filter @roamcli/runner dev --server ws://127.0.0.1:8787/v1/runner --token {token || "dev-token"}</pre>
        </div>
      ) : null}

      {selectedRunner ? (
        <>
          <section className="mobile-controls" aria-label="Mobile runner controls">
            <label>
              <span>Runner</span>
              <select value={selectedRunnerId} onChange={(event) => selectRunner(event.target.value)}>
                {runners.map((runner) => (
                  <option key={runner.runnerId} value={runner.runnerId}>
                    {runner.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Session</span>
              <select value={selectedSession?.id ?? ""} onChange={(event) => setSelectedSessionId(event.target.value)}>
                {runnerSessions.map((session) => (
                  <option key={session.id} value={session.id}>
                    {session.title}
                  </option>
                ))}
              </select>
            </label>
            <details>
              <summary>New session</summary>
              <NewSessionForm key={selectedRunner.runnerId} runner={selectedRunner} onCreate={createSession} />
            </details>
          </section>

          <nav className="tablet-tabs" aria-label="Tablet workspace tabs">
            {workspaceTabs.map((tab) => (
              <WorkspaceTabButton key={tab.id} tab={tab} activeTab={activeTab} onChange={setActiveTab} />
            ))}
          </nav>

          <main className="app-grid">
            <RunnerSidebar
              runners={runners}
              selectedRunnerId={selectedRunnerId}
              sessions={sessions}
              selectedSessionId={selectedSession?.id ?? ""}
              onSelectRunner={selectRunner}
              onSelectSession={setSelectedSessionId}
              onCreateSession={createSession}
            />
            {selectedSession ? (
              <ChatPanel session={selectedSession} messages={sessionMessages} onSend={sendMessage} onControl={sendControl} />
            ) : (
              <section className="chat-column" aria-label="Conversation">
                <div className="empty-state compact">Create a session on the selected runner.</div>
              </section>
            )}
            <aside className="workspace-column" aria-label="Workspace tools">
              <nav className="workspace-tabs" aria-label="Tool tabs">
                {workspaceTabs
                  .filter((tab) => tab.id !== "chat")
                  .map((tab) => (
                    <WorkspaceTabButton key={tab.id} tab={tab} activeTab={activeTab === "chat" ? "files" : activeTab} onChange={setActiveTab} />
                  ))}
              </nav>
              <div className="workspace-scroll">
                <div className="workspace-surface files-surface">
                  <FilePanel
                    files={sessionFiles}
                    treeState={sessionFileTreeState}
                    selectedPath={selectedFilePath}
                    fileContent={fileContent}
                    editorContent={editorContent}
                    contentState={fileContentState}
                    saveState={fileSaveState}
                    onSelectFile={selectFile}
                    onChangeContent={setEditorContent}
                    onSaveFile={saveSelectedFile}
                  />
                </div>
                <div className="workspace-surface terminal-surface">
                  <TerminalPanel lines={sessionTerminalLines} streamState={connectionState} onCommand={sendTerminalCommand} onControl={sendControl} />
                </div>
                <div className="workspace-surface approvals-surface">
                  <PushSettings />
                  <ApprovalCenter
                    approvals={sessionApprovals}
                    hunks={hunks}
                    onResolveApproval={resolveApproval}
                    onResolveHunk={resolveHunk}
                    onApplyPatch={applyAcceptedPatch}
                    patchApplyState={patchApplyState}
                  />
                  <ArtifactList artifacts={artifacts.filter((artifact) => !selectedSession || artifact.sessionId === selectedSession.id)} />
                </div>
              </div>
            </aside>
          </main>

          <BottomTabs activeTab={activeTab} onChange={setActiveTab} />
        </>
      ) : null}
    </div>
  );
}

function WorkspaceTabButton({
  tab,
  activeTab,
  onChange
}: {
  tab: (typeof workspaceTabs)[number];
  activeTab: WorkspaceTab;
  onChange: (tab: WorkspaceTab) => void;
}) {
  const Icon = tab.icon;
  return (
    <button type="button" className={activeTab === tab.id ? "is-active" : ""} onClick={() => onChange(tab.id)}>
      <Icon size={16} />
      <span>{tab.label}</span>
    </button>
  );
}

function ArtifactList({ artifacts }: { artifacts: Artifact[] }) {
  return (
    <section className="tool-panel" aria-label="Artifacts">
      <div className="tool-panel-header">
        <h2 className="panel-title">Artifacts</h2>
        <span className="text-xs text-ink-500">{artifacts.length}</span>
      </div>
      {artifacts.length === 0 ? <div className="empty-state compact">No artifacts uploaded for this session.</div> : null}
      {artifacts.map((artifact) => (
        <article key={artifact.id} className="approval-card">
          <h3 className="truncate font-medium text-ink-900">{artifact.name}</h3>
          <p className="mt-1 text-xs text-ink-500">
            {artifact.kind} · {artifact.mimeType} · {artifact.size} bytes
          </p>
          {artifact.kind === "patch" ? (
            <pre aria-label={`${artifact.name} metadata`}>
              {JSON.stringify(
                {
                  id: artifact.id,
                  sha256: artifact.sha256,
                  storagePath: artifact.storagePath,
                  createdAt: artifact.createdAt
                },
                null,
                2
              )}
            </pre>
          ) : null}
        </article>
      ))}
    </section>
  );
}

function upsertBy<T>(items: T[], next: T, keyOf: (item: T) => string): T[] {
  const key = keyOf(next);
  const exists = items.some((item) => keyOf(item) === key);
  return exists ? items.map((item) => (keyOf(item) === key ? next : item)) : [next, ...items];
}

function mergePatchHunks(current: PatchHunk[], next: PatchHunk[]): PatchHunk[] {
  return next.reduce((items, hunk) => upsertBy(items, hunk, (item) => item.id), current);
}

function extractPatchHunks(approvals: Approval[]): PatchHunk[] {
  return approvals.flatMap((approval) => {
    if (approval.kind !== "applyPatch") {
      return [];
    }
    const payload = approval.payload as { hunks?: unknown };
    if (!Array.isArray(payload.hunks)) {
      return [];
    }
    return payload.hunks.filter(isPatchHunk);
  });
}

function buildPatchFromHunks(hunks: PatchHunk[]): string {
  if (hunks.length === 0) {
    return "";
  }
  const grouped = new Map<string, PatchHunk[]>();
  for (const hunk of hunks) {
    grouped.set(hunk.filePath, [...(grouped.get(hunk.filePath) ?? []), hunk]);
  }
  return [...grouped.entries()]
    .flatMap(([filePath, fileHunks]) => [
      `diff --git a/${filePath} b/${filePath}`,
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      ...fileHunks.flatMap((hunk) => [hunk.header, ...hunk.lines])
    ])
    .join("\n")
    .concat("\n");
}

function isPatchHunk(value: unknown): value is PatchHunk {
  if (!value || typeof value !== "object") {
    return false;
  }
  const hunk = value as Partial<PatchHunk>;
  return (
    typeof hunk.id === "string" &&
    typeof hunk.filePath === "string" &&
    typeof hunk.header === "string" &&
    Array.isArray(hunk.lines) &&
    hunk.lines.every((line) => typeof line === "string") &&
    (hunk.status === undefined || hunk.status === "pending" || hunk.status === "accepted" || hunk.status === "rejected" || hunk.status === "edited")
  );
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}
