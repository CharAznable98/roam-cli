import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentActivity,
  AgentActivityKind,
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
  MessageAttachment,
  Project,
  ProjectPromptPreset,
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

interface ProjectPromptPresetRow {
  id: string;
  project_id: string;
  title: string;
  content: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
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
  streaming: number;
  created_at: string;
}

interface AgentActivityRow {
  id: string;
  session_id: string;
  agent: AgentKind;
  kind: AgentActivityKind;
  label: string;
  created_at: string;
}

interface MessageAttachmentRow {
  id: string;
  session_id: string;
  message_id: string;
  runner_id: string;
  kind: "image";
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  runner_storage_path: string;
  status: "available" | "deleted";
  created_at: string;
  deleted_at: string | null;
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
  resolved_by: "owner" | null;
  resolver_session_id: string | null;
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

interface OwnerCredentialRow {
  id: "owner";
  password_record_json: string;
  created_at: string;
  updated_at: string;
}

interface AuthSessionRow {
  id: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  absolute_expires_at: string;
  user_agent: string | null;
  ip_hash: string | null;
}

interface AuthSettingRow {
  key: string;
  value: string;
  updated_at: string;
}

export type StoredMessageAttachment = MessageAttachment & {
  runnerStoragePath: string;
};

export interface OwnerCredentialRecord {
  passwordRecordJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSessionRecord {
  id: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  absoluteExpiresAt: string;
  userAgent?: string;
  ipHash?: string;
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

  getOwnerCredential(): OwnerCredentialRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM owner_credentials WHERE id = 'owner'")
      .get() as OwnerCredentialRow | undefined;
    return row
      ? {
          passwordRecordJson: row.password_record_json,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  setOwnerCredential(passwordRecordJson: string, now: string): void {
    this.db
      .prepare(
        `INSERT INTO owner_credentials (id, password_record_json, created_at, updated_at)
         VALUES ('owner', ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           password_record_json = excluded.password_record_json,
           updated_at = excluded.updated_at`,
      )
      .run(passwordRecordJson, now, now);
  }

  clearOwnerCredential(): void {
    this.db.prepare("DELETE FROM owner_credentials WHERE id = 'owner'").run();
  }

  createAuthSession(session: AuthSessionRecord): AuthSessionRecord {
    this.db
      .prepare(
        `INSERT INTO auth_sessions (id, token_hash, created_at, last_seen_at, absolute_expires_at, user_agent, ip_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.tokenHash,
        session.createdAt,
        session.lastSeenAt,
        session.absoluteExpiresAt,
        session.userAgent ?? null,
        session.ipHash ?? null,
      );
    return session;
  }

  getAuthSessionByTokenHash(tokenHash: string): AuthSessionRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM auth_sessions WHERE token_hash = ?")
      .get(tokenHash) as AuthSessionRow | undefined;
    return row ? toAuthSession(row) : undefined;
  }

  getAuthSession(id: string): AuthSessionRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM auth_sessions WHERE id = ?")
      .get(id) as AuthSessionRow | undefined;
    return row ? toAuthSession(row) : undefined;
  }

  listAuthSessions(): AuthSessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM auth_sessions ORDER BY last_seen_at DESC")
      .all() as unknown as AuthSessionRow[];
    return rows.map(toAuthSession);
  }

  touchAuthSession(id: string, lastSeenAt: string): void {
    this.db
      .prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?")
      .run(lastSeenAt, id);
  }

  deleteAuthSession(id: string): void {
    this.db.prepare("DELETE FROM auth_sessions WHERE id = ?").run(id);
  }

  clearAuthSessions(): string[] {
    const ids = this.listAuthSessions().map((session) => session.id);
    this.db.prepare("DELETE FROM auth_sessions").run();
    return ids;
  }

  getAuthSetting(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT * FROM auth_settings WHERE key = ?")
      .get(key) as AuthSettingRow | undefined;
    return row?.value;
  }

  setAuthSetting(key: string, value: string, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO auth_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(key, value, updatedAt);
  }

  deleteAuthSetting(key: string): void {
    this.db.prepare("DELETE FROM auth_settings WHERE key = ?").run(key);
  }

  clearSetupToken(): void {
    this.deleteAuthSetting("setup_token_hash");
    this.deleteAuthSetting("setup_token_created_at");
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

  listProjectPromptPresets(projectId: string): ProjectPromptPreset[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM project_prompt_presets WHERE project_id = ? ORDER BY sort_order ASC, created_at DESC",
      )
      .all(projectId) as unknown as ProjectPromptPresetRow[];
    return rows.map(toProjectPromptPreset);
  }

  getProjectPromptPreset(
    projectId: string,
    id: string,
  ): ProjectPromptPreset | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM project_prompt_presets WHERE project_id = ? AND id = ?",
      )
      .get(projectId, id) as ProjectPromptPresetRow | undefined;
    return row ? toProjectPromptPreset(row) : undefined;
  }

  createProjectPromptPreset(preset: ProjectPromptPreset): ProjectPromptPreset {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "UPDATE project_prompt_presets SET sort_order = sort_order + 1 WHERE project_id = ?",
        )
        .run(preset.projectId);
      this.db
        .prepare(
          `INSERT INTO project_prompt_presets (id, project_id, title, content, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          preset.id,
          preset.projectId,
          preset.title,
          preset.content,
          preset.order,
          preset.createdAt,
          preset.updatedAt,
        );
      this.db.exec("COMMIT");
      return preset;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateProjectPromptPreset(
    projectId: string,
    id: string,
    input: { title?: string; content?: string; updatedAt: string },
  ): ProjectPromptPreset | undefined {
    const existing = this.getProjectPromptPreset(projectId, id);
    if (!existing) {
      return undefined;
    }
    this.db
      .prepare(
        "UPDATE project_prompt_presets SET title = ?, content = ?, updated_at = ? WHERE project_id = ? AND id = ?",
      )
      .run(
        input.title ?? existing.title,
        input.content ?? existing.content,
        input.updatedAt,
        projectId,
        id,
      );
    return this.getProjectPromptPreset(projectId, id);
  }

  deleteProjectPromptPreset(projectId: string, id: string): boolean {
    const result = this.db
      .prepare(
        "DELETE FROM project_prompt_presets WHERE project_id = ? AND id = ?",
      )
      .run(projectId, id);
    return result.changes > 0;
  }

  reorderProjectPromptPresets(
    projectId: string,
    presetIds: string[],
  ): ProjectPromptPreset[] {
    this.db.exec("BEGIN");
    try {
      const update = this.db.prepare(
        "UPDATE project_prompt_presets SET sort_order = ? WHERE project_id = ? AND id = ?",
      );
      presetIds.forEach((id, index) => {
        update.run(index, projectId, id);
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.listProjectPromptPresets(projectId);
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

  clearSessionWorktreeDeleted(
    id: string,
    updatedAt: string,
  ): Session | undefined {
    this.db
      .prepare(
        "UPDATE sessions SET worktree_deleted_at = NULL, updated_at = ? WHERE id = ?",
      )
      .run(updatedAt, id);
    return this.getSession(id);
  }

  addMessage(message: Message): Message {
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, role, content, encrypted, streaming, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.sessionId,
        message.role,
        message.content,
        message.encrypted ? 1 : 0,
        message.streaming ? 1 : 0,
        message.createdAt,
      );
    return message;
  }

  applyAssistantOutput(
    sessionId: string,
    outputId: string,
    content: string | undefined,
    mode: "append" | "replace",
    done: boolean,
    createdAt: string,
    encrypted: boolean,
  ): { message: Message; created: boolean } | undefined {
    const id = streamMessageId(sessionId, outputId);
    const existing = this.db
      .prepare("SELECT * FROM messages WHERE id = ? AND session_id = ?")
      .get(id, sessionId) as MessageRow | undefined;
    if (existing) {
      if (mode === "replace" && content !== undefined) {
        this.db
          .prepare(
            "UPDATE messages SET content = ?, streaming = ? WHERE id = ?",
          )
          .run(content, done ? 0 : 1, id);
      } else if (content !== undefined && content.length > 0) {
        this.db
          .prepare(
            "UPDATE messages SET content = content || ?, streaming = ? WHERE id = ?",
          )
          .run(content, done ? 0 : 1, id);
      } else {
        this.db
          .prepare("UPDATE messages SET streaming = ? WHERE id = ?")
          .run(done ? 0 : 1, id);
      }
      return {
        message:
          this.listMessages(sessionId).find((message) => message.id === id) ??
          toMessage(existing),
        created: false,
      };
    }
    if (content === undefined) {
      return undefined;
    }
    const message: Message = {
      id,
      sessionId,
      role: "assistant",
      content,
      encrypted,
      ...(done ? {} : { streaming: true }),
      createdAt,
    };
    return { message: this.addMessage(message), created: true };
  }

  listMessages(sessionId: string): Message[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC",
      )
      .all(sessionId) as unknown as MessageRow[];
    return rows.map(toMessage);
  }

  addAgentActivity(activity: AgentActivity): AgentActivity {
    this.db
      .prepare(
        `INSERT INTO agent_activities (id, session_id, agent, kind, label, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        activity.id,
        activity.sessionId,
        activity.agent,
        activity.kind,
        activity.label,
        activity.createdAt,
      );
    return activity;
  }

  listAgentActivities(sessionId: string): AgentActivity[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM agent_activities WHERE session_id = ? ORDER BY created_at ASC, rowid ASC",
      )
      .all(sessionId) as unknown as AgentActivityRow[];
    return rows.map(toAgentActivity);
  }

  addMessageAttachments(
    attachments: readonly StoredMessageAttachment[],
  ): StoredMessageAttachment[] {
    const insert = this.db.prepare(
      `INSERT INTO message_attachments (id, session_id, message_id, runner_id, kind, name, mime_type, size, sha256, runner_storage_path, status, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         deleted_at = excluded.deleted_at`,
    );
    for (const attachment of attachments) {
      insert.run(
        attachment.id,
        attachment.sessionId,
        attachment.messageId,
        attachment.runnerId,
        attachment.kind,
        attachment.name,
        attachment.mimeType,
        attachment.size,
        attachment.sha256,
        attachment.runnerStoragePath,
        attachment.status,
        attachment.createdAt,
        attachment.deletedAt ?? null,
      );
    }
    return [...attachments];
  }

  listMessageAttachments(sessionId: string): MessageAttachment[] {
    return this.listStoredMessageAttachments(sessionId).map(
      toPublicMessageAttachment,
    );
  }

  listStoredMessageAttachments(sessionId: string): StoredMessageAttachment[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM message_attachments WHERE session_id = ? ORDER BY created_at ASC, rowid ASC",
      )
      .all(sessionId) as unknown as MessageAttachmentRow[];
    return rows.map(toStoredMessageAttachment);
  }

  getStoredMessageAttachment(
    sessionId: string,
    attachmentId: string,
  ): StoredMessageAttachment | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM message_attachments WHERE session_id = ? AND id = ?",
      )
      .get(sessionId, attachmentId) as MessageAttachmentRow | undefined;
    return row ? toStoredMessageAttachment(row) : undefined;
  }

  markSessionAttachmentsDeleted(
    sessionId: string,
    deletedAt: string,
  ): StoredMessageAttachment[] {
    this.db
      .prepare(
        "UPDATE message_attachments SET status = 'deleted', deleted_at = ? WHERE session_id = ? AND status <> 'deleted'",
      )
      .run(deletedAt, sessionId);
    return this.listStoredMessageAttachments(sessionId);
  }

  upsertApproval(approval: Approval): Approval {
    this.db
      .prepare(
        `INSERT INTO approvals (id, session_id, runner_id, kind, summary, payload_json, status, requested_at, resolved_at, resolved_by, resolver_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           resolved_at = excluded.resolved_at,
           resolved_by = excluded.resolved_by,
           resolver_session_id = excluded.resolver_session_id,
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
        approval.resolvedBy ?? null,
        approval.resolverSessionId ?? null,
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

      CREATE TABLE IF NOT EXISTS project_prompt_presets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS project_prompt_presets_project_order_idx
        ON project_prompt_presets(project_id, sort_order, created_at);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        encrypted INTEGER NOT NULL DEFAULT 0,
        streaming INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_activities (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        kind TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS message_attachments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        runner_storage_path TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        deleted_at TEXT,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE
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
        resolved_by TEXT,
        resolver_session_id TEXT,
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

      CREATE TABLE IF NOT EXISTS owner_credentials (
        id TEXT PRIMARY KEY,
        password_record_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        absolute_expires_at TEXT NOT NULL,
        user_agent TEXT,
        ip_hash TEXT
      );

      CREATE TABLE IF NOT EXISTS auth_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
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
    this.addColumnIfMissing(
      "messages",
      "streaming",
      "INTEGER NOT NULL DEFAULT 0",
    );
    this.addColumnIfMissing("approvals", "resolved_by", "TEXT");
    this.addColumnIfMissing("approvals", "resolver_session_id", "TEXT");
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

function toProjectPromptPreset(
  row: ProjectPromptPresetRow,
): ProjectPromptPreset {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    content: row.content,
    order: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    ...(row.streaming ? { streaming: true } : {}),
    createdAt: row.created_at,
  };
}

function streamMessageId(sessionId: string, outputId: string): string {
  const digest = createHash("sha256")
    .update(outputId)
    .digest("hex")
    .slice(0, 24);
  return `stream_${sessionId}_${digest}`;
}

function toAgentActivity(row: AgentActivityRow): AgentActivity {
  return {
    id: row.id,
    sessionId: row.session_id,
    agent: row.agent,
    kind: row.kind,
    label: row.label,
    createdAt: row.created_at,
  };
}

function toAuthSession(row: AuthSessionRow): AuthSessionRecord {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    absoluteExpiresAt: row.absolute_expires_at,
    ...(row.user_agent ? { userAgent: row.user_agent } : {}),
    ...(row.ip_hash ? { ipHash: row.ip_hash } : {}),
  };
}

function toStoredMessageAttachment(
  row: MessageAttachmentRow,
): StoredMessageAttachment {
  return {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id,
    runnerId: row.runner_id,
    kind: row.kind,
    name: row.name,
    mimeType: row.mime_type,
    size: row.size,
    sha256: row.sha256,
    runnerStoragePath: row.runner_storage_path,
    status: row.status,
    createdAt: row.created_at,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
  };
}

function toPublicMessageAttachment(
  attachment: StoredMessageAttachment,
): MessageAttachment {
  return {
    id: attachment.id,
    sessionId: attachment.sessionId,
    messageId: attachment.messageId,
    runnerId: attachment.runnerId,
    kind: attachment.kind,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    sha256: attachment.sha256,
    status: attachment.status,
    createdAt: attachment.createdAt,
    ...(attachment.deletedAt ? { deletedAt: attachment.deletedAt } : {}),
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
    ...(row.resolved_by ? { resolvedBy: row.resolved_by } : {}),
    ...(row.resolver_session_id
      ? { resolverSessionId: row.resolver_session_id }
      : {}),
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
