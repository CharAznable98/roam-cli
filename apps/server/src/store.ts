import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentKind,
  Approval,
  ApprovalKind,
  ApprovalStatus,
  Artifact,
  ArtifactKind,
  ChatRole,
  Message,
  RunnerRegistration,
  Session,
  SessionStatus
} from "@roamcli/protocol";

interface SessionRow {
  id: string;
  title: string;
  runner_id: string;
  agent: AgentKind;
  status: SessionStatus;
  cwd: string;
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

  createSession(session: Session): Session {
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, runner_id, agent, status, cwd, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(session.id, session.title, session.runnerId, session.agent, session.status, session.cwd, session.createdAt, session.updatedAt);
    return session;
  }

  listSessions(): Session[] {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY created_at DESC").all() as unknown as SessionRow[];
    return rows.map(toSession);
  }

  getSession(id: string): Session | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    return row ? toSession(row) : undefined;
  }

  updateSessionStatus(id: string, status: SessionStatus, updatedAt: string): Session | undefined {
    this.db.prepare("UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?").run(status, updatedAt, id);
    return this.getSession(id);
  }

  addMessage(message: Message): Message {
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, encrypted, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(message.id, message.sessionId, message.role, message.content, message.encrypted ? 1 : 0, message.createdAt);
    return message;
  }

  appendAssistantToken(sessionId: string, content: string, createdAt: string): Message {
    const id = `stream_${sessionId}`;
    const existing = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
    if (existing) {
      this.db.prepare("UPDATE messages SET content = content || ? WHERE id = ?").run(content, id);
      return this.listMessages(sessionId).find((message) => message.id === id) ?? toMessage(existing);
    }
    const message: Message = {
      id,
      sessionId,
      role: "assistant",
      content,
      encrypted: false,
      createdAt
    };
    return this.addMessage(message);
  }

  listMessages(sessionId: string): Message[] {
    const rows = this.db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC").all(sessionId) as unknown as MessageRow[];
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
           payload_json = excluded.payload_json`
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
        approval.clientSignature ?? null
      );
    return approval;
  }

  getApproval(id: string): Approval | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
    return row ? toApproval(row) : undefined;
  }

  listApprovals(sessionId: string): Approval[] {
    const rows = this.db.prepare("SELECT * FROM approvals WHERE session_id = ? ORDER BY requested_at ASC").all(sessionId) as unknown as ApprovalRow[];
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
           storage_path = excluded.storage_path`
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
        artifact.createdAt
      );
    return artifact;
  }

  listArtifacts(sessionId: string): Artifact[] {
    const rows = this.db.prepare("SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at ASC").all(sessionId) as unknown as ArtifactRow[];
    return rows.map(toArtifact);
  }

  setRunnerOnline(runner: RunnerRegistration, online: boolean, seenAt: string): RunnerRegistration {
    this.db
      .prepare(
        `INSERT INTO runners (runner_id, registration_json, online, last_seen_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(runner_id) DO UPDATE SET
           registration_json = excluded.registration_json,
           online = excluded.online,
           last_seen_at = excluded.last_seen_at`
      )
      .run(runner.runnerId, JSON.stringify(runner), online ? 1 : 0, seenAt);
    return runner;
  }

  markRunnerOffline(runnerId: string, seenAt: string): void {
    if (this.closed) {
      return;
    }
    this.db.prepare("UPDATE runners SET online = 0, last_seen_at = ? WHERE runner_id = ?").run(seenAt, runnerId);
  }

  getRunner(runnerId: string): RunnerRegistration | undefined {
    const row = this.db.prepare("SELECT * FROM runners WHERE runner_id = ?").get(runnerId) as RunnerRow | undefined;
    return row ? (JSON.parse(row.registration_json) as RunnerRegistration) : undefined;
  }

  listOnlineRunners(): RunnerRegistration[] {
    const rows = this.db.prepare("SELECT * FROM runners WHERE online = 1 ORDER BY last_seen_at DESC").all() as unknown as RunnerRow[];
    return rows.map((row) => JSON.parse(row.registration_json) as RunnerRegistration);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        status TEXT NOT NULL,
        cwd TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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
    `);
  }
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title,
    runnerId: row.runner_id,
    agent: row.agent,
    status: row.status,
    cwd: row.cwd,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    encrypted: Boolean(row.encrypted),
    createdAt: row.created_at
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
    ...(row.client_signature ? { clientSignature: row.client_signature } : {})
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
    createdAt: row.created_at
  };
}
