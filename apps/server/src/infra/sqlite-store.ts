import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentKind,
  Approval,
  ApprovalKind,
  ApprovalStatus,
  Artifact,
  ArtifactKind,
  ChatRole,
  GitJob,
  GitJobStatus,
  Message,
  Project,
  RunnerRegistration,
  Session,
  SessionStatus,
} from "@roamcli/shared/protocol";

interface ProjectRow {
  id: string;
  name: string;
  runner_id: string;
  directory: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  last_active_at: string;
}

interface SessionRow {
  id: string;
  title: string;
  project_id: string;
  runner_id: string;
  agent: AgentKind;
  status: SessionStatus;
  execution_mode: "direct" | "managed_worktree" | "remote";
  execution_folder: string;
  cwd: string;
  git_branch_name: string | null;
  git_base_ref: string | null;
  git_base_sha: string | null;
  worktree_deleted_at: string | null;
  agent_thread_id: string | null;
  archived_at: string | null;
  archived_by_project_id: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: ChatRole;
  content: string;
  encrypted: number;
  created_at: string;
}

interface ApprovalRow {
  id: string;
  session_id: string;
  runner_id: string;
  kind: ApprovalKind;
  summary: string;
  payload_json: string;
  status: ApprovalStatus;
  requested_at: string;
  resolved_at: string | null;
  client_signature: string | null;
}

interface ArtifactRow {
  id: string;
  session_id: string;
  kind: ArtifactKind;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  storage_path: string;
  created_at: string;
}

interface RunnerRow {
  runner_id: string;
  registration_json: string;
  online: number;
  last_seen_at: string;
}

interface GitJobRow {
  id: string;
  project_id: string;
  session_id: string | null;
  context_kind: "project" | "session_worktree";
  operation: string;
  status: GitJobStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  error_summary: string | null;
}

export class ServerStore {
  readonly dbPath: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.dbPath = path.join(dataDir, "roamcli.sqlite");
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.closed = true;
    this.db.close();
  }

  createProject(project: Project): Project {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, runner_id, directory, archived_at, created_at, updated_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.name,
        project.runnerId,
        project.directory,
        project.archivedAt ?? null,
        project.createdAt,
        project.updatedAt,
        project.lastActiveAt,
      );
    return project;
  }

  listProjects(options: { includeArchived?: boolean } = {}): Project[] {
    const rows = this.db
      .prepare(
        options.includeArchived
          ? "SELECT * FROM projects ORDER BY last_active_at DESC, created_at DESC"
          : "SELECT * FROM projects WHERE archived_at IS NULL ORDER BY last_active_at DESC, created_at DESC",
      )
      .all() as unknown as ProjectRow[];
    return rows.map(toProject);
  }

  getProject(id: string): Project | undefined {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(id) as ProjectRow | undefined;
    return row ? toProject(row) : undefined;
  }

  updateProject(
    id: string,
    input: { name?: string; directory?: string; updatedAt: string },
  ): Project | undefined {
    const existing = this.getProject(id);
    if (!existing) {
      return undefined;
    }
    this.db
      .prepare(
        "UPDATE projects SET name = ?, directory = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        input.name ?? existing.name,
        input.directory ?? existing.directory,
        input.updatedAt,
        id,
      );
    return this.getProject(id);
  }

  archiveProject(id: string, archivedAt: string): Project | undefined {
    this.db
      .prepare(
        "UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(archivedAt, archivedAt, id);
    this.db
      .prepare(
        "UPDATE sessions SET archived_at = ?, archived_by_project_id = ?, updated_at = ? WHERE project_id = ? AND archived_at IS NULL",
      )
      .run(archivedAt, id, archivedAt, id);
    return this.getProject(id);
  }

  restoreProject(id: string, restoredAt: string): Project | undefined {
    this.db
      .prepare(
        "UPDATE projects SET archived_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(restoredAt, id);
    this.db
      .prepare(
        "UPDATE sessions SET archived_at = NULL, archived_by_project_id = NULL, updated_at = ? WHERE project_id = ? AND archived_by_project_id = ?",
      )
      .run(restoredAt, id, id);
    return this.getProject(id);
  }

  touchProject(id: string, activeAt: string): void {
    this.db
      .prepare(
        "UPDATE projects SET last_active_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(activeAt, activeAt, id);
  }

  createSession(session: Session): Session {
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, project_id, runner_id, agent, status, execution_mode, execution_folder, cwd, git_branch_name, git_base_ref, git_base_sha, worktree_deleted_at, agent_thread_id, archived_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.title,
        session.projectId,
        session.runnerId,
        session.agent,
        session.status,
        session.executionMode,
        session.executionFolder,
        session.cwd,
        session.gitBranchName ?? null,
        session.gitBaseRef ?? null,
        session.gitBaseSha ?? null,
        session.worktreeDeletedAt ?? null,
        session.agentThreadId ?? null,
        session.archivedAt ?? null,
        session.createdAt,
        session.updatedAt,
      );
    this.touchProject(session.projectId, session.updatedAt);
    return session;
  }

  listSessions(options: { includeArchived?: boolean } = {}): Session[] {
    const rows = this.db
      .prepare(
        options.includeArchived
          ? "SELECT * FROM sessions ORDER BY created_at DESC"
          : "SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY created_at DESC",
      )
      .all() as unknown as SessionRow[];
    return rows.map(toSession);
  }

  getSession(id: string): Session | undefined {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;
    return row ? toSession(row) : undefined;
  }

  deleteSession(id: string): boolean {
    const result = this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return result.changes > 0;
  }

  archiveSession(id: string, archivedAt: string): Session | undefined {
    this.db
      .prepare(
        "UPDATE sessions SET archived_at = ?, archived_by_project_id = NULL, updated_at = ? WHERE id = ?",
      )
      .run(archivedAt, archivedAt, id);
    return this.getSession(id);
  }

  restoreSession(id: string, restoredAt: string): Session | undefined {
    this.db
      .prepare(
        "UPDATE sessions SET archived_at = NULL, archived_by_project_id = NULL, updated_at = ? WHERE id = ?",
      )
      .run(restoredAt, id);
    return this.getSession(id);
  }

  updateSessionStatus(
    id: string,
    status: SessionStatus,
    updatedAt: string,
  ): Session | undefined {
    this.db
      .prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, updatedAt, id);
    return this.getSession(id);
  }

  updateSessionTitle(
    id: string,
    title: string,
    updatedAt: string,
  ): Session | undefined {
    this.db
      .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, updatedAt, id);
    return this.getSession(id);
  }

  updateSessionThread(
    id: string,
    agentThreadId: string,
    updatedAt: string,
  ): Session | undefined {
    this.db
      .prepare(
        "UPDATE sessions SET agent_thread_id = ?, updated_at = ? WHERE id = ?",
      )
      .run(agentThreadId, updatedAt, id);
    return this.getSession(id);
  }

  markSessionWorktreeDeleted(
    id: string,
    deletedAt: string,
  ): Session | undefined {
    this.db
      .prepare(
        "UPDATE sessions SET worktree_deleted_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(deletedAt, deletedAt, id);
    return this.getSession(id);
  }

  addMessage(message: Message): Message {
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, encrypted, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.sessionId,
        message.role,
        message.content,
        message.encrypted ? 1 : 0,
        message.createdAt,
      );
    return message;
  }

  appendAssistantToken(
    sessionId: string,
    content: string,
    createdAt: string,
    encrypted: boolean,
  ): Message {
    const streamPrefix = `stream_${sessionId}_`;
    const latest = this.db
      .prepare(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(sessionId) as MessageRow | undefined;
    if (
      latest?.role === "assistant" &&
      latest.id.startsWith(streamPrefix) &&
      Boolean(latest.encrypted) === encrypted
    ) {
      const id = latest.id;
      this.db
        .prepare("UPDATE messages SET content = content || ? WHERE id = ?")
        .run(content, id);
      return (
        this.listMessages(sessionId).find((message) => message.id === id) ??
        toMessage(latest)
      );
    }
    const id = `${streamPrefix}${randomUUID()}`;
    const message: Message = {
      id,
      sessionId,
      role: "assistant",
      content,
      encrypted,
      createdAt,
    };
    return this.addMessage(message);
  }

  listMessages(sessionId: string): Message[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC",
      )
      .all(sessionId) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  upsertApproval(approval: Approval): Approval {
    this.db
      .prepare(
        `INSERT INTO approvals (id, session_id, runner_id, kind, summary, payload_json, status, requested_at, resolved_at, client_signature)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           resolved_at = excluded.resolved_at,
           client_signature = excluded.client_signature,
           payload_json = excluded.payload_json`,
      )
      .run(
        approval.id,
        approval.sessionId,
        approval.runnerId,
        approval.kind,
        approval.summary,
        JSON.stringify(approval.payload),
        approval.status,
        approval.requestedAt,
        approval.resolvedAt ?? null,
        approval.clientSignature ?? null,
      );
    return approval;
  }

  getApproval(id: string): Approval | undefined {
    const row = this.db
      .prepare("SELECT * FROM approvals WHERE id = ?")
      .get(id) as ApprovalRow | undefined;
    return row ? toApproval(row) : undefined;
  }

  listApprovals(sessionId: string): Approval[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM approvals WHERE session_id = ? ORDER BY requested_at ASC",
      )
      .all(sessionId) as unknown as ApprovalRow[];
    return rows.map(toApproval);
  }

  addArtifact(artifact: Artifact): Artifact {
    this.db
      .prepare(
        `INSERT INTO artifacts (id, session_id, kind, name, mime_type, size, sha256, storage_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           name = excluded.name,
           mime_type = excluded.mime_type,
           size = excluded.size,
           sha256 = excluded.sha256,
           storage_path = excluded.storage_path`,
      )
      .run(
        artifact.id,
        artifact.sessionId,
        artifact.kind,
        artifact.name,
        artifact.mimeType,
        artifact.size,
        artifact.sha256,
        artifact.storagePath,
        artifact.createdAt,
      );
    return artifact;
  }

  listArtifacts(sessionId: string): Artifact[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at ASC",
      )
      .all(sessionId) as unknown as ArtifactRow[];
    return rows.map(toArtifact);
  }

  setRunnerOnline(
    runner: RunnerRegistration,
    online: boolean,
    seenAt: string,
  ): RunnerRegistration {
    this.db
      .prepare(
        `INSERT INTO runners (runner_id, registration_json, online, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(runner_id) DO UPDATE SET
           registration_json = excluded.registration_json,
           online = excluded.online,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(runner.runnerId, JSON.stringify(runner), online ? 1 : 0, seenAt);
    return runner;
  }

  markRunnerOffline(runnerId: string, seenAt: string): void {
    if (this.closed) {
      return;
    }
    this.db
      .prepare(
        "UPDATE runners SET online = 0, last_seen_at = ? WHERE runner_id = ?",
      )
      .run(seenAt, runnerId);
  }

  getRunner(runnerId: string): RunnerRegistration | undefined {
    const row = this.db
      .prepare("SELECT * FROM runners WHERE runner_id = ?")
      .get(runnerId) as RunnerRow | undefined;
    return row
      ? (JSON.parse(row.registration_json) as RunnerRegistration)
      : undefined;
  }

  listOnlineRunners(): RunnerRegistration[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM runners WHERE online = 1 ORDER BY last_seen_at DESC",
      )
      .all() as unknown as RunnerRow[];
    return rows.map(
      (row) => JSON.parse(row.registration_json) as RunnerRegistration,
    );
  }

  upsertGitJob(job: GitJob): GitJob {
    this.db
      .prepare(
        `INSERT INTO git_jobs (id, project_id, session_id, context_kind, operation, status, created_at, started_at, finished_at, error_code, error_summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           started_at = excluded.started_at,
           finished_at = excluded.finished_at,
           error_code = excluded.error_code,
           error_summary = excluded.error_summary`,
      )
      .run(
        job.id,
        job.projectId,
        job.sessionId ?? null,
        job.contextKind,
        job.operation,
        job.status,
        job.createdAt,
        job.startedAt ?? null,
        job.finishedAt ?? null,
        job.errorCode ?? null,
        job.errorSummary ?? null,
      );
    return job;
  }

  listGitJobs(projectId: string): GitJob[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM git_jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 100",
      )
      .all(projectId) as unknown as GitJobRow[];
    return rows.map(toGitJob);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        project_id TEXT,
        runner_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        status TEXT NOT NULL,
        execution_mode TEXT NOT NULL DEFAULT 'direct',
        execution_folder TEXT,
        cwd TEXT NOT NULL,
        agent_thread_id TEXT,
        archived_at TEXT,
        archived_by_project_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        directory TEXT NOT NULL,
        archived_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        encrypted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        resolved_at TEXT,
        client_signature TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS runners (
        runner_id TEXT PRIMARY KEY,
        registration_json TEXT NOT NULL,
        online INTEGER NOT NULL DEFAULT 0,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS git_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        session_id TEXT,
        context_kind TEXT NOT NULL,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        error_code TEXT,
        error_summary TEXT,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE SET NULL
      );
    `);
    this.addColumnIfMissing("sessions", "project_id", "TEXT");
    this.addColumnIfMissing(
      "sessions",
      "execution_mode",
      "TEXT NOT NULL DEFAULT 'direct'",
    );
    this.addColumnIfMissing("sessions", "execution_folder", "TEXT");
    this.addColumnIfMissing("sessions", "git_branch_name", "TEXT");
    this.addColumnIfMissing("sessions", "git_base_ref", "TEXT");
    this.addColumnIfMissing("sessions", "git_base_sha", "TEXT");
    this.addColumnIfMissing("sessions", "worktree_deleted_at", "TEXT");
    this.addColumnIfMissing("sessions", "agent_thread_id", "TEXT");
    this.addColumnIfMissing("sessions", "archived_at", "TEXT");
    this.addColumnIfMissing("sessions", "archived_by_project_id", "TEXT");
    this.discardLegacySessionsWithoutProjects();
  }

  private addColumnIfMissing(
    table: string,
    column: string,
    definition: string,
  ): void {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (!rows.some((row) => row.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  private discardLegacySessionsWithoutProjects(): void {
    this.db.prepare("DELETE FROM sessions WHERE project_id IS NULL").run();
  }
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    runnerId: row.runner_id,
    directory: row.directory,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActiveAt: row.last_active_at,
  };
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id,
    runnerId: row.runner_id,
    agent: row.agent,
    status: row.status,
    executionMode: row.execution_mode,
    executionFolder: row.execution_folder ?? row.cwd,
    cwd: row.cwd,
    ...(row.git_branch_name ? { gitBranchName: row.git_branch_name } : {}),
    ...(row.git_base_ref ? { gitBaseRef: row.git_base_ref } : {}),
    ...(row.git_base_sha ? { gitBaseSha: row.git_base_sha } : {}),
    ...(row.worktree_deleted_at
      ? { worktreeDeletedAt: row.worktree_deleted_at }
      : {}),
    ...(row.agent_thread_id ? { agentThreadId: row.agent_thread_id } : {}),
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    encrypted: Boolean(row.encrypted),
    createdAt: row.created_at,
  };
}

function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    sessionId: row.session_id,
    runnerId: row.runner_id,
    kind: row.kind,
    summary: row.summary,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    status: row.status,
    requestedAt: row.requested_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    ...(row.client_signature ? { clientSignature: row.client_signature } : {}),
  };
}

function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    name: row.name,
    mimeType: row.mime_type,
    size: row.size,
    sha256: row.sha256,
    storagePath: row.storage_path,
    createdAt: row.created_at,
  };
}

function toGitJob(row: GitJobRow): GitJob {
  return {
    id: row.id,
    projectId: row.project_id,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    contextKind: row.context_kind,
    operation: row.operation,
    status: row.status,
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_summary ? { errorSummary: row.error_summary } : {}),
  };
}
