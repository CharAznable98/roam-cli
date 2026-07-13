import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  AgentActivity,
  AgentActivityKind,
  AgentRuntimeConfig,
  RunnerAgentRuntimeConfigSetting,
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
  RunnerCommand,
  RunnerRegistration,
  SessionStartResult,
  Session,
  SessionStatus,
  SessionStatusCheckResult,
} from "@roamcli/shared/protocol";
import {
  AgentRuntimeConfigSchema,
  RunnerRegistrationSchema,
} from "@roamcli/shared/protocol";

interface ProjectRow {
  id: string;
  name: string;
  runner_id: string;
  directory: string;
  pinned_at: string | null;
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
  pinned_at: string | null;
  archived_at: string | null;
  archived_by_project_id: string | null;
  agent_runtime_config_json: string | null;
  pending_input_request_id: string | null;
  creation_request_fingerprint: string | null;
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

interface AttachmentCleanupJobRow {
  project_id: string;
  session_id: string;
  runner_id: string;
  attachment_id: string;
  runner_storage_path: string;
  created_at: string;
}

interface PendingInputDeliveryRow {
  delivery_id: string;
  kind: "input" | "start";
  runner_id: string;
  session_id: string;
  input_request_id: string | null;
  message_json: string;
  attachments_json: string;
  start_command_json: string | null;
  persist_message: number;
  initial_session_create: number;
  receipt_required: number;
  attempt_count: number;
  last_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
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

interface RunnerEventStreamRow {
  runner_id: string;
  stream_id: string;
  committed_through: number;
}

interface CommittedDeliveryReceiptRow {
  effect_id: string;
  runner_id: string;
  result_json: string;
  created_at: string;
}

interface RunnerAgentRuntimeConfigSettingRow {
  runner_id: string;
  agent: AgentKind;
  config_json: string;
  updated_at: string;
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

export interface AttachmentCleanupJob {
  projectId: string;
  sessionId: string;
  runnerId: string;
  attachmentId: string;
  runnerStoragePath: string;
  createdAt: string;
}

export interface PendingInputDelivery {
  deliveryId: string;
  kind: "input" | "start";
  runnerId: string;
  sessionId: string;
  inputRequestId?: string;
  message: Message;
  attachments: StoredMessageAttachment[];
  startCommand?: Extract<RunnerCommand, { type: "startSession" }>;
  persistMessage?: boolean;
  initialSessionCreate?: boolean;
  receiptRequired?: boolean;
  attemptCount: number;
  lastAttemptAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PendingMessageDelivery {
  messageId: string;
  content: string;
  createdAt: string;
  attachments: MessageAttachment[];
}

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

export type RunnerEventStreamNegotiation =
  | { ok: true; ackThrough: number }
  | {
      ok: false;
      reason: "acknowledgement_ahead";
      ackThrough: number;
    };

export type RunnerEventProcessingResult =
  | { status: "committed" | "duplicate"; ackThrough: number }
  | {
      status: "gap";
      ackThrough: number;
      expectedSequence: number;
    }
  | { status: "stream_mismatch"; ackThrough: number };

export interface CommittedDeliveryReceipt {
  effectId: string;
  runnerId: string;
  result: SessionStartResult | SessionStatusCheckResult;
  createdAt: string;
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
        `INSERT INTO projects (id, name, runner_id, directory, pinned_at, archived_at, created_at, updated_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        project.id,
        project.name,
        project.runnerId,
        project.directory,
        project.pinnedAt ?? null,
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
          ? "SELECT * FROM projects ORDER BY pinned_at IS NULL, pinned_at DESC, last_active_at DESC, created_at DESC"
          : "SELECT * FROM projects WHERE archived_at IS NULL ORDER BY pinned_at IS NULL, pinned_at DESC, last_active_at DESC, created_at DESC",
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
    input: {
      name?: string;
      directory?: string;
      pinnedAt?: string | null;
      updatedAt: string;
    },
  ): Project | undefined {
    const existing = this.getProject(id);
    if (!existing) {
      return undefined;
    }
    this.db
      .prepare(
        "UPDATE projects SET name = ?, directory = ?, pinned_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        input.name ?? existing.name,
        input.directory ?? existing.directory,
        input.pinnedAt === undefined
          ? (existing.pinnedAt ?? null)
          : input.pinnedAt,
        input.updatedAt,
        id,
      );
    return this.getProject(id);
  }

  archiveProject(id: string, archivedAt: string): Project | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const pendingRows = this.db
        .prepare(
          `SELECT pending_input_deliveries.* FROM pending_input_deliveries
           INNER JOIN sessions ON sessions.id = pending_input_deliveries.session_id
           WHERE sessions.project_id = ?`,
        )
        .all(id) as unknown as PendingInputDeliveryRow[];
      const insertCleanup = this.db.prepare(
        `INSERT OR IGNORE INTO attachment_cleanup_jobs
           (project_id, session_id, runner_id, attachment_id, runner_storage_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const row of pendingRows) {
        const pending = toPendingInputDelivery(row);
        for (const attachment of pending.attachments) {
          insertCleanup.run(
            id,
            pending.sessionId,
            pending.runnerId,
            attachment.id,
            attachment.runnerStoragePath,
            archivedAt,
          );
        }
      }
      this.db
        .prepare(
          `INSERT OR IGNORE INTO attachment_cleanup_jobs
             (project_id, session_id, runner_id, attachment_id, runner_storage_path, created_at)
           SELECT sessions.project_id, message_attachments.session_id,
                  message_attachments.runner_id, message_attachments.id,
                  message_attachments.runner_storage_path, ?
           FROM message_attachments
           INNER JOIN sessions ON sessions.id = message_attachments.session_id
           WHERE sessions.project_id = ? AND message_attachments.status = 'available'`,
        )
        .run(archivedAt, id);
      this.db
        .prepare(
          `DELETE FROM sessions
           WHERE project_id = ? AND status = 'pending'
             AND id IN (
               SELECT session_id FROM pending_input_deliveries
               WHERE kind = 'start' AND initial_session_create = 1
             )`,
        )
        .run(id);
      this.db
        .prepare(
          `DELETE FROM pending_input_deliveries
           WHERE session_id IN (SELECT id FROM sessions WHERE project_id = ?)`,
        )
        .run(id);
      this.db
        .prepare(
          "UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(archivedAt, archivedAt, id);
      this.db
        .prepare(
          `UPDATE sessions
           SET archived_at = ?, archived_by_project_id = ?,
               status = CASE WHEN status = 'pending' THEN 'stopped' ELSE status END,
               updated_at = ?
           WHERE project_id = ? AND archived_at IS NULL`,
        )
        .run(archivedAt, id, archivedAt, id);
      this.db.exec("COMMIT");
      return this.getProject(id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
        `INSERT INTO sessions (id, title, project_id, runner_id, agent, status, execution_mode, execution_folder, cwd, git_branch_name, git_base_ref, git_base_sha, worktree_deleted_at, agent_thread_id, pinned_at, archived_at, agent_runtime_config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        session.pinnedAt ?? null,
        session.archivedAt ?? null,
        session.agentRuntimeConfig &&
          Object.keys(session.agentRuntimeConfig).length > 0
          ? JSON.stringify(session.agentRuntimeConfig)
          : null,
        session.createdAt,
        session.updatedAt,
      );
    this.touchProject(session.projectId, session.updatedAt);
    return session;
  }

  createSessionWithPendingStart(
    session: Session,
    delivery: Omit<
      PendingInputDelivery,
      "attemptCount" | "lastAttemptAt" | "lastError" | "updatedAt"
    >,
    creationRequestFingerprint?: string,
  ): { session: Session; delivery: PendingInputDelivery } | undefined {
    if (delivery.kind !== "start" || !delivery.startCommand) {
      throw new Error("pending session start requires a start command");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const activeProject = this.db
        .prepare("SELECT 1 FROM projects WHERE id = ? AND archived_at IS NULL")
        .get(session.projectId);
      if (!activeProject) {
        const insertCleanup = this.db.prepare(
          `INSERT OR IGNORE INTO attachment_cleanup_jobs
             (project_id, session_id, runner_id, attachment_id, runner_storage_path, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const attachment of delivery.attachments) {
          insertCleanup.run(
            session.projectId,
            session.id,
            session.runnerId,
            attachment.id,
            attachment.runnerStoragePath,
            session.updatedAt,
          );
        }
        this.db.exec("COMMIT");
        return undefined;
      }
      const created = this.createSession(session);
      if (creationRequestFingerprint) {
        this.db
          .prepare(
            "UPDATE sessions SET creation_request_fingerprint = ? WHERE id = ?",
          )
          .run(creationRequestFingerprint, session.id);
      }
      const pending = this.putPendingInputDelivery(delivery);
      this.db.exec("COMMIT");
      return { session: created, delivery: pending };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listSessions(options: { includeArchived?: boolean } = {}): Session[] {
    const rows = this.db
      .prepare(
        options.includeArchived
          ? "SELECT * FROM sessions ORDER BY pinned_at IS NULL, pinned_at DESC, created_at DESC"
          : "SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY pinned_at IS NULL, pinned_at DESC, created_at DESC",
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

  getSessionCreationRequestFingerprint(id: string): string | undefined {
    const row = this.db
      .prepare("SELECT creation_request_fingerprint FROM sessions WHERE id = ?")
      .get(id) as { creation_request_fingerprint: string | null } | undefined;
    return row?.creation_request_fingerprint ?? undefined;
  }

  deleteSession(id: string): boolean {
    const result = this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return result.changes > 0;
  }

  archiveSession(id: string, archivedAt: string): Session | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const session = this.db
        .prepare("SELECT project_id FROM sessions WHERE id = ?")
        .get(id) as { project_id: string } | undefined;
      if (session) {
        const pendingRows = this.db
          .prepare(
            "SELECT * FROM pending_input_deliveries WHERE session_id = ?",
          )
          .all(id) as unknown as PendingInputDeliveryRow[];
        const insertCleanup = this.db.prepare(
          `INSERT OR IGNORE INTO attachment_cleanup_jobs
             (project_id, session_id, runner_id, attachment_id, runner_storage_path, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const row of pendingRows) {
          const pending = toPendingInputDelivery(row);
          for (const attachment of pending.attachments) {
            insertCleanup.run(
              session.project_id,
              id,
              pending.runnerId,
              attachment.id,
              attachment.runnerStoragePath,
              archivedAt,
            );
          }
        }
        this.db
          .prepare(
            `INSERT OR IGNORE INTO attachment_cleanup_jobs
               (project_id, session_id, runner_id, attachment_id, runner_storage_path, created_at)
             SELECT ?, session_id, runner_id, id, runner_storage_path, ?
             FROM message_attachments
             WHERE session_id = ? AND status = 'available'`,
          )
          .run(session.project_id, archivedAt, id);
      }
      this.db
        .prepare("DELETE FROM pending_input_deliveries WHERE session_id = ?")
        .run(id);
      this.db
        .prepare(
          `UPDATE sessions
           SET archived_at = ?, archived_by_project_id = NULL,
               status = CASE WHEN status = 'pending' THEN 'stopped' ELSE status END,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(archivedAt, archivedAt, id);
      this.db.exec("COMMIT");
      return this.getSession(id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
      .prepare(
        `UPDATE sessions
         SET status = ?,
             pending_input_request_id = CASE
               WHEN ? = 'waiting_input' THEN pending_input_request_id
               ELSE NULL
             END,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(status, status, updatedAt, id);
    return this.getSession(id);
  }

  setPendingUserInputRequest(sessionId: string, inputRequestId: string): void {
    this.db
      .prepare(
        `UPDATE sessions
         SET pending_input_request_id = ?
         WHERE id = ? AND status NOT IN ('completed', 'failed', 'stopped')`,
      )
      .run(inputRequestId, sessionId);
  }

  getPendingUserInputRequest(sessionId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT pending_input_request_id
         FROM sessions
         WHERE id = ? AND status = 'waiting_input'`,
      )
      .get(sessionId) as
      | { pending_input_request_id: string | null }
      | undefined;
    return row?.pending_input_request_id ?? undefined;
  }

  clearPendingUserInputRequest(
    sessionId: string,
    inputRequestId: string,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE sessions
         SET pending_input_request_id = NULL
         WHERE id = ? AND pending_input_request_id = ?`,
      )
      .run(sessionId, inputRequestId);
    return result.changes > 0;
  }

  updateSessionTitle(
    id: string,
    title: string,
    updatedAt: string,
  ): Session | undefined {
    return this.updateSession(id, { title, updatedAt });
  }

  updateSession(
    id: string,
    input: {
      title?: string;
      pinnedAt?: string | null;
      updatedAt: string;
    },
  ): Session | undefined {
    const existing = this.getSession(id);
    if (!existing) {
      return undefined;
    }
    this.db
      .prepare(
        "UPDATE sessions SET title = ?, pinned_at = ?, updated_at = ? WHERE id = ?",
      )
      .run(
        input.title ?? existing.title,
        input.pinnedAt === undefined
          ? (existing.pinnedAt ?? null)
          : input.pinnedAt,
        input.updatedAt,
        id,
      );
    return this.getSession(id);
  }

  countPinnedSessions(projectId: string): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM sessions WHERE project_id = ? AND archived_at IS NULL AND pinned_at IS NOT NULL",
      )
      .get(projectId) as { count: number } | undefined;
    return row?.count ?? 0;
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

  getMessage(sessionId: string, messageId: string): Message | undefined {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE session_id = ? AND id = ?")
      .get(sessionId, messageId) as MessageRow | undefined;
    return row ? toMessage(row) : undefined;
  }

  getMessageById(messageId: string): Message | undefined {
    const row = this.db
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(messageId) as MessageRow | undefined;
    return row ? toMessage(row) : undefined;
  }

  putPendingInputDelivery(
    delivery: Omit<
      PendingInputDelivery,
      "attemptCount" | "lastAttemptAt" | "lastError" | "updatedAt"
    >,
  ): PendingInputDelivery {
    this.db
      .prepare(
        `INSERT INTO pending_input_deliveries
           (delivery_id, kind, runner_id, session_id, input_request_id, message_json,
            attachments_json, start_command_json, persist_message, initial_session_create, receipt_required, attempt_count,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(delivery_id) DO NOTHING`,
      )
      .run(
        delivery.deliveryId,
        delivery.kind,
        delivery.runnerId,
        delivery.sessionId,
        delivery.inputRequestId ?? null,
        JSON.stringify(delivery.message),
        JSON.stringify(delivery.attachments),
        delivery.startCommand ? JSON.stringify(delivery.startCommand) : null,
        delivery.persistMessage === false ? 0 : 1,
        delivery.initialSessionCreate ? 1 : 0,
        delivery.receiptRequired ? 1 : 0,
        delivery.createdAt,
        delivery.createdAt,
      );
    const stored = this.getPendingInputDelivery(delivery.deliveryId);
    if (!stored) {
      throw new Error("failed to persist pending input delivery");
    }
    return stored;
  }

  preparePendingSessionStart(
    delivery: Omit<
      PendingInputDelivery,
      "attemptCount" | "lastAttemptAt" | "lastError" | "updatedAt"
    >,
    restartedAt: string,
  ): { delivery: PendingInputDelivery; session: Session } {
    if (delivery.kind !== "start" || !delivery.startCommand) {
      throw new Error("pending session start requires a start command");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stored = this.putPendingInputDelivery(delivery);
      const pending = this.updateSessionStatus(
        delivery.sessionId,
        "pending",
        restartedAt,
      );
      const restarted = pending?.worktreeDeletedAt
        ? this.clearSessionWorktreeDeleted(delivery.sessionId, restartedAt)
        : pending;
      if (!restarted) {
        throw new Error("session no longer exists");
      }
      this.db.exec("COMMIT");
      return { delivery: stored, session: restarted };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  promotePendingInputDeliveryToStart(
    deliveryId: string,
    startCommand: Extract<RunnerCommand, { type: "startSession" }>,
    receiptRequired: boolean,
    restartedAt: string,
  ): { delivery: PendingInputDelivery; session: Session } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const pending = this.getPendingInputDelivery(deliveryId);
      if (!pending || pending.kind !== "input") {
        throw new Error("pending input delivery no longer exists");
      }
      this.db
        .prepare(
          `UPDATE pending_input_deliveries
           SET kind = 'start', input_request_id = NULL, start_command_json = ?,
               receipt_required = ?,
               attempt_count = 0, last_attempt_at = NULL, last_error = NULL,
               updated_at = ?
           WHERE delivery_id = ? AND kind = 'input'`,
        )
        .run(
          JSON.stringify(startCommand),
          receiptRequired ? 1 : 0,
          restartedAt,
          deliveryId,
        );
      const restarted = this.updateSessionStatus(
        pending.sessionId,
        "pending",
        restartedAt,
      );
      if (!restarted) {
        throw new Error("session no longer exists");
      }
      const promoted = this.getPendingInputDelivery(deliveryId);
      if (!promoted || promoted.kind !== "start") {
        throw new Error("failed to promote pending input delivery");
      }
      this.db.exec("COMMIT");
      return { delivery: promoted, session: restarted };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getPendingInputDelivery(
    deliveryId: string,
  ): PendingInputDelivery | undefined {
    const row = this.db
      .prepare("SELECT * FROM pending_input_deliveries WHERE delivery_id = ?")
      .get(deliveryId) as PendingInputDeliveryRow | undefined;
    return row ? toPendingInputDelivery(row) : undefined;
  }

  listPendingInputDeliveries(runnerId: string): PendingInputDelivery[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_input_deliveries
         WHERE runner_id = ?
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(runnerId) as unknown as PendingInputDeliveryRow[];
    return rows.map(toPendingInputDelivery);
  }

  markPendingInputDeliveryAttempt(
    deliveryId: string,
    attemptedAt: string,
    error?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE pending_input_deliveries
         SET attempt_count = attempt_count + 1,
             last_attempt_at = ?,
             last_error = ?,
             updated_at = ?
         WHERE delivery_id = ?`,
      )
      .run(attemptedAt, error ?? null, attemptedAt, deliveryId);
  }

  deletePendingInputDelivery(deliveryId: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM pending_input_deliveries WHERE delivery_id = ?")
        .run(deliveryId).changes > 0
    );
  }

  cancelPendingInputDeliveriesForSession(
    sessionId: string,
    cancelledAt: string,
  ): {
    deleted: number;
    cleanupRunnerIds: string[];
    session: Session | undefined;
  } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const session = this.db
        .prepare("SELECT project_id FROM sessions WHERE id = ?")
        .get(sessionId) as { project_id: string } | undefined;
      const pendingRows = this.db
        .prepare("SELECT * FROM pending_input_deliveries WHERE session_id = ?")
        .all(sessionId) as unknown as PendingInputDeliveryRow[];
      const cleanupRunnerIds = new Set<string>();
      if (session) {
        const isFinalized = this.db.prepare(
          `SELECT 1 FROM message_attachments
           WHERE session_id = ? AND id = ?`,
        );
        const insertCleanup = this.db.prepare(
          `INSERT OR IGNORE INTO attachment_cleanup_jobs
             (project_id, session_id, runner_id, attachment_id, runner_storage_path, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const row of pendingRows) {
          const pending = toPendingInputDelivery(row);
          for (const attachment of pending.attachments) {
            if (isFinalized.get(sessionId, attachment.id)) {
              continue;
            }
            insertCleanup.run(
              session.project_id,
              sessionId,
              pending.runnerId,
              attachment.id,
              attachment.runnerStoragePath,
              cancelledAt,
            );
            cleanupRunnerIds.add(pending.runnerId);
          }
        }
      }
      const deleted = Number(
        this.db
          .prepare("DELETE FROM pending_input_deliveries WHERE session_id = ?")
          .run(sessionId).changes,
      );
      if (deleted > 0) {
        this.db
          .prepare(
            `UPDATE sessions SET status = 'stopped', updated_at = ?
             WHERE id = ? AND status = 'pending'`,
          )
          .run(cancelledAt, sessionId);
      }
      this.db.exec("COMMIT");
      return {
        deleted,
        cleanupRunnerIds: [...cleanupRunnerIds],
        session: this.getSession(sessionId),
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  rejectPendingSessionStart(
    deliveryId: string,
    rejectedAt: string,
  ): Session | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const pending = this.getPendingInputDelivery(deliveryId);
      if (!pending) {
        this.db.exec("COMMIT");
        return undefined;
      }
      this.deletePendingInputDelivery(deliveryId);
      if (pending.kind === "start") {
        this.db
          .prepare(
            `UPDATE sessions SET status = 'failed', updated_at = ?
             WHERE id = ? AND status = 'pending'`,
          )
          .run(rejectedAt, pending.sessionId);
      }
      this.db.exec("COMMIT");
      return this.getSession(pending.sessionId);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  finalizePendingInputDelivery(deliveryId: string):
    | {
        message: Message;
        attachments: StoredMessageAttachment[];
        created: boolean;
      }
    | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const pending = this.getPendingInputDelivery(deliveryId);
      if (!pending) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const shouldPersistMessage = pending.persistMessage !== false;
      const existing = shouldPersistMessage
        ? this.getMessage(pending.message.sessionId, pending.message.id)
        : undefined;
      if (
        existing &&
        (existing.role !== pending.message.role ||
          existing.content !== pending.message.content ||
          existing.createdAt !== pending.message.createdAt)
      ) {
        throw new Error(
          "input delivery message id conflicts with existing data",
        );
      }
      if (shouldPersistMessage && !existing) {
        this.addMessage(pending.message);
      }
      if (shouldPersistMessage) {
        this.addMessageAttachments(pending.attachments);
      }
      if (pending.inputRequestId) {
        this.clearPendingUserInputRequest(
          pending.sessionId,
          pending.inputRequestId,
        );
      }
      this.deletePendingInputDelivery(deliveryId);
      this.db.exec("COMMIT");
      return {
        message: pending.message,
        attachments: pending.attachments,
        created: shouldPersistMessage && !existing,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

  listVisibleMessages(sessionId: string): Message[] {
    return this.listMessages(sessionId);
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

  listVisibleMessageAttachments(sessionId: string): MessageAttachment[] {
    return this.listMessageAttachments(sessionId);
  }

  listPendingMessageDeliveries(sessionId: string): PendingMessageDelivery[] {
    return this.listPendingInputDeliveriesForSession(sessionId)
      .filter((delivery) => delivery.persistMessage !== false)
      .map((delivery) => ({
        messageId: delivery.message.id,
        content: delivery.message.content,
        createdAt: delivery.createdAt,
        attachments: delivery.attachments.map(toPublicMessageAttachment),
      }));
  }

  private listPendingInputDeliveriesForSession(
    sessionId: string,
  ): PendingInputDelivery[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pending_input_deliveries
         WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(sessionId) as unknown as PendingInputDeliveryRow[];
    return rows.map(toPendingInputDelivery);
  }

  listStoredMessageAttachments(sessionId: string): StoredMessageAttachment[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM message_attachments WHERE session_id = ? ORDER BY created_at ASC, rowid ASC",
      )
      .all(sessionId) as unknown as MessageAttachmentRow[];
    return rows.map(toStoredMessageAttachment);
  }

  listAttachmentCleanupJobs(projectId: string): AttachmentCleanupJob[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM attachment_cleanup_jobs
         WHERE project_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(projectId) as unknown as AttachmentCleanupJobRow[];
    return rows.map(toAttachmentCleanupJob);
  }

  listAttachmentCleanupJobsByRunner(runnerId: string): AttachmentCleanupJob[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM attachment_cleanup_jobs
         WHERE runner_id = ? ORDER BY created_at ASC, rowid ASC`,
      )
      .all(runnerId) as unknown as AttachmentCleanupJobRow[];
    return rows.map(toAttachmentCleanupJob);
  }

  deleteAttachmentCleanupJobs(
    sessionId: string,
    attachmentIds: readonly string[],
  ): void {
    if (attachmentIds.length === 0) {
      return;
    }
    const placeholders = attachmentIds.map(() => "?").join(", ");
    this.db
      .prepare(
        `DELETE FROM attachment_cleanup_jobs
         WHERE session_id = ? AND attachment_id IN (${placeholders})`,
      )
      .run(sessionId, ...attachmentIds);
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
    attachmentIds: readonly string[],
    deletedAt: string,
  ): StoredMessageAttachment[] {
    if (attachmentIds.length === 0) {
      return [];
    }
    const placeholders = attachmentIds.map(() => "?").join(", ");
    this.db
      .prepare(
        `UPDATE message_attachments SET status = 'deleted', deleted_at = ?
         WHERE session_id = ? AND status <> 'deleted' AND id IN (${placeholders})`,
      )
      .run(deletedAt, sessionId, ...attachmentIds);
    const deletedIds = new Set(attachmentIds);
    return this.listStoredMessageAttachments(sessionId).filter(
      (attachment) =>
        attachment.status === "deleted" && deletedIds.has(attachment.id),
    );
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

  negotiateRunnerEventStream(
    runnerId: string,
    streamId: string,
    acknowledgedThrough: number,
  ): RunnerEventStreamNegotiation {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getRunnerEventStream(runnerId, streamId);
      if (!existing) {
        if (acknowledgedThrough !== 0) {
          this.db.exec("COMMIT");
          return {
            ok: false,
            reason: "acknowledgement_ahead",
            ackThrough: 0,
          };
        }
        this.db
          .prepare(
            `INSERT INTO runner_event_streams (runner_id, stream_id, committed_through)
             VALUES (?, ?, 0)`,
          )
          .run(runnerId, streamId);
        this.db.exec("COMMIT");
        return { ok: true, ackThrough: 0 };
      }
      if (acknowledgedThrough > existing.committed_through) {
        this.db.exec("COMMIT");
        return {
          ok: false,
          reason: "acknowledgement_ahead",
          ackThrough: existing.committed_through,
        };
      }
      this.db.exec("COMMIT");
      return { ok: true, ackThrough: existing.committed_through };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  processRunnerEvent(
    runnerId: string,
    streamId: string,
    sequence: number,
    handle: () => void,
  ): RunnerEventProcessingResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stream = this.getRunnerEventStream(runnerId, streamId);
      if (!stream) {
        this.db.exec("COMMIT");
        return {
          status: "stream_mismatch",
          ackThrough: 0,
        };
      }
      if (sequence <= stream.committed_through) {
        this.db.exec("COMMIT");
        return { status: "duplicate", ackThrough: stream.committed_through };
      }
      const expectedSequence = stream.committed_through + 1;
      if (sequence !== expectedSequence) {
        this.db.exec("COMMIT");
        return {
          status: "gap",
          ackThrough: stream.committed_through,
          expectedSequence,
        };
      }

      handle();
      const update = this.db
        .prepare(
          `UPDATE runner_event_streams
           SET committed_through = ?
           WHERE runner_id = ? AND stream_id = ? AND committed_through = ?`,
        )
        .run(sequence, runnerId, streamId, stream.committed_through);
      if (update.changes !== 1) {
        throw new Error("runner event stream changed during transaction");
      }
      this.db.exec("COMMIT");
      return { status: "committed", ackThrough: sequence };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  putCommittedDeliveryReceipt(
    runnerId: string,
    kind: "sessionStartResult" | "sessionStatusCheckResult",
    result: SessionStartResult | SessionStatusCheckResult,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO committed_delivery_receipts
           (effect_id, runner_id, result_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        `${runnerId}:${kind}:${result.requestId}`,
        runnerId,
        JSON.stringify(result),
        new Date().toISOString(),
      );
  }

  listCommittedDeliveryReceipts(): CommittedDeliveryReceipt[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM committed_delivery_receipts
         ORDER BY created_at ASC, effect_id ASC`,
      )
      .all() as unknown as CommittedDeliveryReceiptRow[];
    return rows.map((row) => ({
      effectId: row.effect_id,
      runnerId: row.runner_id,
      result: JSON.parse(row.result_json) as
        | SessionStartResult
        | SessionStatusCheckResult,
      createdAt: row.created_at,
    }));
  }

  deleteCommittedDeliveryReceipt(effectId: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM committed_delivery_receipts WHERE effect_id = ?")
        .run(effectId).changes === 1
    );
  }

  listRunnerAgentRuntimeConfigSettings(): RunnerAgentRuntimeConfigSetting[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM runner_agent_runtime_config_settings ORDER BY runner_id ASC, agent ASC",
      )
      .all() as unknown as RunnerAgentRuntimeConfigSettingRow[];
    return rows.map(toRunnerAgentRuntimeConfigSetting);
  }

  getRunnerAgentRuntimeConfigSetting(
    runnerId: string,
    agent: AgentKind,
  ): RunnerAgentRuntimeConfigSetting | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM runner_agent_runtime_config_settings WHERE runner_id = ? AND agent = ?",
      )
      .get(runnerId, agent) as RunnerAgentRuntimeConfigSettingRow | undefined;
    return row ? toRunnerAgentRuntimeConfigSetting(row) : undefined;
  }

  setRunnerAgentRuntimeConfigSetting(
    runnerId: string,
    agent: AgentKind,
    config: AgentRuntimeConfig,
    updatedAt: string,
  ): RunnerAgentRuntimeConfigSetting | undefined {
    if (Object.keys(config).length === 0) {
      this.db
        .prepare(
          "DELETE FROM runner_agent_runtime_config_settings WHERE runner_id = ? AND agent = ?",
        )
        .run(runnerId, agent);
      return undefined;
    }
    this.db
      .prepare(
        `INSERT INTO runner_agent_runtime_config_settings (runner_id, agent, config_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(runner_id, agent) DO UPDATE SET
           config_json = excluded.config_json,
           updated_at = excluded.updated_at`,
      )
      .run(runnerId, agent, JSON.stringify(config), updatedAt);
    return {
      runnerId,
      agent,
      config,
      updatedAt,
    };
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

  getGitJob(id: string): GitJob | undefined {
    const row = this.db
      .prepare("SELECT * FROM git_jobs WHERE id = ?")
      .get(id) as GitJobRow | undefined;
    return row ? toGitJob(row) : undefined;
  }

  listActiveGitJobs(): GitJob[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM git_jobs
         WHERE status IN ('queued', 'running')
         ORDER BY created_at ASC`,
      )
      .all() as unknown as GitJobRow[];
    return rows.map(toGitJob);
  }

  hasActiveWorktreeRemovalJob(sessionId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1
         FROM git_jobs
         WHERE session_id = ?
           AND operation IN ('remove_worktree', 'archive_remove_worktree')
           AND status IN ('queued', 'running')
         LIMIT 1`,
      )
      .get(sessionId);
    return row !== undefined;
  }

  listSucceededArchiveRemovalJobsPendingSessionArchive(): GitJob[] {
    const rows = this.db
      .prepare(
        `SELECT git_jobs.*
         FROM git_jobs
         JOIN sessions ON sessions.id = git_jobs.session_id
         WHERE git_jobs.operation = 'archive_remove_worktree'
           AND git_jobs.status = 'succeeded'
           AND sessions.archived_at IS NULL
         ORDER BY git_jobs.finished_at ASC`,
      )
      .all() as unknown as GitJobRow[];
    return rows.map(toGitJob);
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
        pinned_at TEXT,
        archived_at TEXT,
        archived_by_project_id TEXT,
        pending_input_request_id TEXT,
        creation_request_fingerprint TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        directory TEXT NOT NULL,
        pinned_at TEXT,
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

      CREATE TABLE IF NOT EXISTS attachment_cleanup_jobs (
        project_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        runner_storage_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(project_id, session_id, attachment_id)
      );

      CREATE INDEX IF NOT EXISTS attachment_cleanup_jobs_project_idx
        ON attachment_cleanup_jobs(project_id, created_at);

      CREATE TABLE IF NOT EXISTS pending_input_deliveries (
        delivery_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'input',
        runner_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        input_request_id TEXT,
        message_json TEXT NOT NULL,
        attachments_json TEXT NOT NULL,
        start_command_json TEXT,
        persist_message INTEGER NOT NULL DEFAULT 1,
        initial_session_create INTEGER NOT NULL DEFAULT 0,
        receipt_required INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS pending_input_deliveries_runner_idx
        ON pending_input_deliveries(runner_id, created_at);

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

      CREATE TABLE IF NOT EXISTS runner_event_streams (
        runner_id TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        committed_through INTEGER NOT NULL DEFAULT 0 CHECK (committed_through >= 0),
        PRIMARY KEY (runner_id, stream_id)
      );

      CREATE TABLE IF NOT EXISTS committed_delivery_receipts (
        effect_id TEXT PRIMARY KEY,
        runner_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runner_agent_runtime_config_settings (
        runner_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        config_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(runner_id, agent)
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

      CREATE TABLE IF NOT EXISTS schema_migrations (
        key TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
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
    this.addColumnIfMissing("sessions", "pinned_at", "TEXT");
    this.addColumnIfMissing("sessions", "archived_at", "TEXT");
    this.addColumnIfMissing("sessions", "archived_by_project_id", "TEXT");
    this.addColumnIfMissing("sessions", "agent_runtime_config_json", "TEXT");
    this.addColumnIfMissing("sessions", "pending_input_request_id", "TEXT");
    this.addColumnIfMissing("sessions", "creation_request_fingerprint", "TEXT");
    this.addColumnIfMissing(
      "pending_input_deliveries",
      "start_command_json",
      "TEXT",
    );
    this.addColumnIfMissing(
      "pending_input_deliveries",
      "kind",
      "TEXT NOT NULL DEFAULT 'input'",
    );
    this.addColumnIfMissing(
      "pending_input_deliveries",
      "persist_message",
      "INTEGER NOT NULL DEFAULT 1",
    );
    this.migratePendingStartReceiptRequirement();
    this.migrateInitialSessionCreateMarker();
    this.addColumnIfMissing("projects", "pinned_at", "TEXT");
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
    if (rows.some((row) => row.name === column)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private backfillLegacyInitialSessionCreates(): void {
    const rows = this.db
      .prepare(
        `SELECT pending.delivery_id, pending.session_id,
                pending.start_command_json, sessions.created_at,
                sessions.updated_at, sessions.status,
                sessions.agent_thread_id,
                EXISTS (
                  SELECT 1 FROM messages WHERE messages.session_id = sessions.id
                ) AS has_messages
         FROM pending_input_deliveries AS pending
         INNER JOIN sessions ON sessions.id = pending.session_id
         WHERE pending.kind = 'start'
           AND pending.persist_message = 1
           AND pending.initial_session_create = 0`,
      )
      .all() as Array<{
      delivery_id: string;
      session_id: string;
      start_command_json: string | null;
      created_at: string;
      updated_at: string;
      status: string;
      agent_thread_id: string | null;
      has_messages: number;
    }>;
    const markInitial = this.db.prepare(
      `UPDATE pending_input_deliveries
       SET initial_session_create = 1
       WHERE delivery_id = ?`,
    );
    for (const row of rows) {
      if (
        row.status !== "pending" ||
        row.agent_thread_id !== null ||
        row.has_messages !== 0 ||
        row.updated_at !== row.created_at ||
        !row.start_command_json
      ) {
        continue;
      }
      let command: unknown;
      try {
        command = JSON.parse(row.start_command_json);
      } catch {
        continue;
      }
      if (
        !isLegacyInitialStartCommand(
          command,
          row.session_id,
          row.delivery_id,
          row.created_at,
        )
      ) {
        continue;
      }
      markInitial.run(row.delivery_id);
    }
  }

  private migratePendingStartReceiptRequirement(): void {
    const migrationKey = "backfill_pending_start_receipt_required_v1";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.addColumnIfMissing(
        "pending_input_deliveries",
        "receipt_required",
        "INTEGER NOT NULL DEFAULT 0",
      );
      const applied = this.db
        .prepare("SELECT 1 FROM schema_migrations WHERE key = ?")
        .get(migrationKey);
      if (!applied) {
        const rows = this.db
          .prepare(
            `SELECT pending.delivery_id, sessions.agent,
                    sessions.runner_id, runners.registration_json
             FROM pending_input_deliveries AS pending
             INNER JOIN sessions ON sessions.id = pending.session_id
             LEFT JOIN runners ON runners.runner_id = sessions.runner_id
             WHERE pending.kind = 'start'
               AND pending.receipt_required = 0`,
          )
          .all() as Array<{
          delivery_id: string;
          agent: AgentKind;
          runner_id: string;
          registration_json: string | null;
        }>;
        const requireReceipt = this.db.prepare(
          `UPDATE pending_input_deliveries
           SET receipt_required = 1
           WHERE delivery_id = ? AND kind = 'start'`,
        );
        for (const row of rows) {
          if (!row.registration_json) {
            continue;
          }
          let registration: unknown;
          try {
            registration = JSON.parse(row.registration_json);
          } catch {
            continue;
          }
          const parsed = RunnerRegistrationSchema.safeParse(registration);
          if (
            !parsed.success ||
            parsed.data.runnerId !== row.runner_id ||
            !parsed.data.capabilities.some(
              (capability) =>
                capability.kind === row.agent &&
                capability.supportsDurableSessionStart === true,
            )
          ) {
            continue;
          }
          requireReceipt.run(row.delivery_id);
        }
        this.db
          .prepare(
            "INSERT INTO schema_migrations (key, applied_at) VALUES (?, ?)",
          )
          .run(migrationKey, new Date().toISOString());
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migrateInitialSessionCreateMarker(): void {
    const migrationKey = "backfill_initial_session_create_v1";
    if (
      this.db
        .prepare("SELECT 1 FROM schema_migrations WHERE key = ?")
        .get(migrationKey)
    ) {
      return;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const applied = this.db
        .prepare("SELECT 1 FROM schema_migrations WHERE key = ?")
        .get(migrationKey);
      if (!applied) {
        this.addColumnIfMissing(
          "pending_input_deliveries",
          "initial_session_create",
          "INTEGER NOT NULL DEFAULT 0",
        );
        this.backfillLegacyInitialSessionCreates();
        this.db
          .prepare(
            "INSERT INTO schema_migrations (key, applied_at) VALUES (?, ?)",
          )
          .run(migrationKey, new Date().toISOString());
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private getRunnerEventStream(
    runnerId: string,
    streamId: string,
  ): RunnerEventStreamRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM runner_event_streams WHERE runner_id = ? AND stream_id = ?",
      )
      .get(runnerId, streamId) as RunnerEventStreamRow | undefined;
  }
}

function isLegacyInitialStartCommand(
  value: unknown,
  sessionId: string,
  deliveryId: string,
  sessionCreatedAt: string,
): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const command = value as Record<string, unknown>;
  if (
    command.type !== "startSession" ||
    command.deliveryId !== deliveryId ||
    "resumeThreadId" in command
  ) {
    return false;
  }
  const session = command.session;
  if (!session || typeof session !== "object") {
    return false;
  }
  const record = session as Record<string, unknown>;
  return (
    record.id === sessionId &&
    record.status === "pending" &&
    record.createdAt === sessionCreatedAt &&
    record.updatedAt === sessionCreatedAt
  );
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    runnerId: row.runner_id,
    directory: row.directory,
    ...(row.pinned_at ? { pinnedAt: row.pinned_at } : {}),
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActiveAt: row.last_active_at,
  };
}

function toPendingInputDelivery(
  row: PendingInputDeliveryRow,
): PendingInputDelivery {
  return {
    deliveryId: row.delivery_id,
    kind: row.kind,
    runnerId: row.runner_id,
    sessionId: row.session_id,
    ...(row.input_request_id ? { inputRequestId: row.input_request_id } : {}),
    message: JSON.parse(row.message_json) as Message,
    attachments: JSON.parse(row.attachments_json) as StoredMessageAttachment[],
    ...(row.start_command_json
      ? {
          startCommand: JSON.parse(row.start_command_json) as Extract<
            RunnerCommand,
            { type: "startSession" }
          >,
        }
      : {}),
    ...(row.persist_message === 0 ? { persistMessage: false } : {}),
    ...(row.initial_session_create ? { initialSessionCreate: true } : {}),
    ...(row.receipt_required ? { receiptRequired: true } : {}),
    attemptCount: row.attempt_count,
    ...(row.last_attempt_at ? { lastAttemptAt: row.last_attempt_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
    ...(row.pinned_at ? { pinnedAt: row.pinned_at } : {}),
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    ...(row.agent_runtime_config_json
      ? {
          agentRuntimeConfig: parseAgentRuntimeConfig(
            row.agent_runtime_config_json,
          ),
        }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRunnerAgentRuntimeConfigSetting(
  row: RunnerAgentRuntimeConfigSettingRow,
): RunnerAgentRuntimeConfigSetting {
  return {
    runnerId: row.runner_id,
    agent: row.agent,
    config: parseAgentRuntimeConfig(row.config_json),
    updatedAt: row.updated_at,
  };
}

function parseAgentRuntimeConfig(value: string): AgentRuntimeConfig {
  try {
    return AgentRuntimeConfigSchema.parse(JSON.parse(value));
  } catch {
    return {};
  }
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

function toAttachmentCleanupJob(
  row: AttachmentCleanupJobRow,
): AttachmentCleanupJob {
  return {
    projectId: row.project_id,
    sessionId: row.session_id,
    runnerId: row.runner_id,
    attachmentId: row.attachment_id,
    runnerStoragePath: row.runner_storage_path,
    createdAt: row.created_at,
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
