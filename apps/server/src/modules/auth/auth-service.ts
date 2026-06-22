import fs from "node:fs";
import path from "node:path";
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  nowIso,
  type AccountSecurityState,
  type ApiChangePassword,
  type ApiLogin,
  type ApiSetupOwner,
  type AuthSessionSummary,
  type AuthStatus,
} from "@roamcli/shared/protocol";
import { newId } from "../../infra/ids.js";
import type {
  AuthSessionRecord,
  ServerStore,
} from "../../infra/sqlite-store.js";
import { fail, ok, type ServiceResult } from "../result.js";

const SESSION_COOKIE = "roamcli_session";
const SETUP_TOKEN_FILE = "setup-token.txt";
const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const ABSOLUTE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const PASSWORD_KEY_LENGTH = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const;

type AuthError =
  | "already_setup"
  | "setup_required"
  | "invalid_credentials"
  | "rate_limited"
  | "unauthorized";

interface PasswordRecord {
  alg: "scrypt";
  salt: string;
  key: string;
  N: number;
  r: number;
  p: number;
  keyLength: number;
}

interface AttemptState {
  count: number;
  blockedUntil: number;
}

export interface AuthenticatedSession {
  record: AuthSessionRecord;
  token: string;
}

export class AuthService {
  private readonly setupTokenPath: string;
  private readonly attempts = new Map<string, AttemptState>();

  constructor(
    private readonly store: ServerStore,
    private readonly dataDir: string,
  ) {
    this.setupTokenPath = path.join(dataDir, SETUP_TOKEN_FILE);
  }

  initialize(options: { resetOwner?: boolean } = {}): void {
    if (options.resetOwner) {
      this.store.clearOwnerCredential();
      this.store.clearAuthSessions();
      this.store.clearSetupToken();
      this.log("auth.owner_reset_requested");
    }

    if (!this.hasOwner()) {
      this.createSetupToken();
      return;
    }

    this.store.clearSetupToken();
    removeFileIfExists(this.setupTokenPath);
  }

  hasOwner(): boolean {
    return this.store.getOwnerCredential() !== undefined;
  }

  getStatus(request: FastifyRequest): AuthStatus {
    if (!this.hasOwner()) {
      return { status: "setup_required" };
    }
    const session = this.authenticateRequest(request);
    if (!session) {
      return { status: "unauthenticated" };
    }
    return {
      status: "authenticated",
      session: toSessionSummary(session.record, session.record.id),
    };
  }

  setupOwner(
    input: ApiSetupOwner,
    request: FastifyRequest,
  ): ServiceResult<{
    session: AuthSessionRecord;
    token: string;
    account: AccountSecurityState;
  }> {
    if (this.hasOwner()) {
      return fail("already_setup");
    }
    const rateKey = this.rateKey("setup", request);
    if (this.isRateLimited(rateKey) || this.isRateLimited("setup:global")) {
      this.log("auth.setup_rate_limited", request);
      return fail("rate_limited");
    }
    const setupTokenHash = this.store.getAuthSetting("setup_token_hash");
    if (
      !setupTokenHash ||
      !constantTimeEqual(hashSecret(input.setupToken), setupTokenHash)
    ) {
      this.recordFailure(rateKey);
      this.recordFailure("setup:global");
      this.log("auth.setup_failed", request);
      return fail("invalid_credentials");
    }

    const now = nowIso();
    this.store.setOwnerCredential(
      JSON.stringify(hashPassword(input.password)),
      now,
    );
    this.store.clearSetupToken();
    removeFileIfExists(this.setupTokenPath);
    if (!this.store.getAuthSetting("runner_token")) {
      this.createRunnerToken(now);
    }
    this.recordSuccess(rateKey);
    this.recordSuccess("setup:global");
    this.log("auth.setup_completed", request);
    const created = this.createSession(request);
    return ok({
      session: created.record,
      token: created.token,
      account: this.getAccountState(created.record.id),
    });
  }

  login(
    input: ApiLogin,
    request: FastifyRequest,
  ): ServiceResult<{
    session: AuthSessionRecord;
    token: string;
    account: AccountSecurityState;
  }> {
    const credential = this.store.getOwnerCredential();
    if (!credential) {
      return fail("setup_required");
    }
    const rateKey = this.rateKey("login", request);
    if (this.isRateLimited(rateKey) || this.isRateLimited("login:global")) {
      this.log("auth.login_rate_limited", request);
      return fail("rate_limited");
    }
    if (
      !verifyPassword(
        input.password,
        JSON.parse(credential.passwordRecordJson) as PasswordRecord,
      )
    ) {
      this.recordFailure(rateKey);
      this.recordFailure("login:global");
      this.log("auth.login_failed", request);
      return fail("invalid_credentials");
    }

    this.recordSuccess(rateKey);
    this.recordSuccess("login:global");
    const created = this.createSession(request);
    this.log("auth.login_succeeded", request, created.record.id);
    return ok({
      session: created.record,
      token: created.token,
      account: this.getAccountState(created.record.id),
    });
  }

  changePassword(
    sessionId: string,
    input: ApiChangePassword,
    request: FastifyRequest,
  ): ServiceResult<{ revokedSessionIds: string[] }> {
    const credential = this.store.getOwnerCredential();
    if (!credential) {
      return fail("setup_required");
    }
    if (
      !verifyPassword(
        input.currentPassword,
        JSON.parse(credential.passwordRecordJson) as PasswordRecord,
      )
    ) {
      this.log("auth.password_change_failed", request, sessionId);
      return fail("invalid_credentials");
    }
    this.store.setOwnerCredential(
      JSON.stringify(hashPassword(input.newPassword)),
      nowIso(),
    );
    const revokedSessionIds = this.store.clearAuthSessions();
    this.log("auth.password_changed", request, sessionId);
    return ok({ revokedSessionIds });
  }

  logout(sessionId: string, request?: FastifyRequest): void {
    this.store.deleteAuthSession(sessionId);
    this.log("auth.logout", request, sessionId);
  }

  logoutAll(request?: FastifyRequest, sessionId?: string): string[] {
    const ids = this.store.clearAuthSessions();
    this.log("auth.logout_all", request, sessionId);
    return ids;
  }

  getAccountState(currentSessionId?: string): AccountSecurityState {
    const token = this.store.getAuthSetting("runner_token");
    const createdAt =
      this.store.getAuthSetting("runner_token_created_at") ?? nowIso();
    const updatedAt =
      this.store.getAuthSetting("runner_token_updated_at") ?? createdAt;
    if (!token) {
      this.createRunnerToken(nowIso());
    }
    return {
      sessions: this.store
        .listAuthSessions()
        .map((session) => toSessionSummary(session, currentSessionId)),
      runnerToken: this.store.getAuthSetting("runner_token") ?? "",
      runnerTokenCreatedAt:
        this.store.getAuthSetting("runner_token_created_at") ?? createdAt,
      runnerTokenUpdatedAt:
        this.store.getAuthSetting("runner_token_updated_at") ?? updatedAt,
      ...(this.store.getAuthSetting("runner_token_last_used_at")
        ? {
            runnerTokenLastUsedAt: this.store.getAuthSetting(
              "runner_token_last_used_at",
            ),
          }
        : {}),
      ...(this.store.getAuthSetting("runner_token_last_runner_id")
        ? {
            runnerTokenLastRunnerId: this.store.getAuthSetting(
              "runner_token_last_runner_id",
            ),
          }
        : {}),
    };
  }

  regenerateRunnerToken(request: FastifyRequest, sessionId: string): string {
    const token = this.createRunnerToken(nowIso());
    this.log("runner.token_regenerated", request, sessionId);
    return token;
  }

  authenticateRunnerToken(token: string, runnerId: string): boolean {
    const expected = this.store.getAuthSetting("runner_token");
    if (!expected || !constantTimeEqual(token, expected)) {
      this.log("runner.auth_failed", undefined, runnerId);
      return false;
    }
    const now = nowIso();
    this.store.setAuthSetting("runner_token_last_used_at", now, now);
    this.store.setAuthSetting("runner_token_last_runner_id", runnerId, now);
    this.log("runner.auth_succeeded", undefined, runnerId);
    return true;
  }

  authenticateRequest(
    request: FastifyRequest,
  ): AuthenticatedSession | undefined {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (!token) {
      return undefined;
    }
    const record = this.store.getAuthSessionByTokenHash(hashSecret(token));
    if (!record) {
      return undefined;
    }
    const now = Date.now();
    if (
      Date.parse(record.absoluteExpiresAt) <= now ||
      Date.parse(record.lastSeenAt) + IDLE_TIMEOUT_MS <= now
    ) {
      this.store.deleteAuthSession(record.id);
      return undefined;
    }
    if (Date.parse(record.lastSeenAt) + TOUCH_INTERVAL_MS <= now) {
      const lastSeenAt = new Date(now).toISOString();
      this.store.touchAuthSession(record.id, lastSeenAt);
      return {
        token,
        record: { ...record, lastSeenAt },
      };
    }
    return { token, record };
  }

  requireSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): AuthenticatedSession | undefined {
    if (!this.hasOwner()) {
      void reply.code(401).send({ error: "setup_required" });
      return undefined;
    }
    const session = this.authenticateRequest(request);
    if (!session) {
      void reply.code(401).send({ error: "unauthorized" });
      return undefined;
    }
    return session;
  }

  setSessionCookie(
    reply: FastifyReply,
    token: string,
    request: FastifyRequest,
  ): void {
    reply.header(
      "set-cookie",
      serializeCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "Strict",
        path: "/",
        maxAge: Math.floor(ABSOLUTE_TIMEOUT_MS / 1000),
        secure: isSecureRequest(request),
      }),
    );
  }

  clearSessionCookie(reply: FastifyReply, request: FastifyRequest): void {
    reply.header(
      "set-cookie",
      serializeCookie(SESSION_COOKIE, "", {
        httpOnly: true,
        sameSite: "Strict",
        path: "/",
        maxAge: 0,
        secure: isSecureRequest(request),
      }),
    );
  }

  private createSetupToken(): string {
    const token = randomToken();
    const now = nowIso();
    this.store.setAuthSetting("setup_token_hash", hashSecret(token), now);
    this.store.setAuthSetting("setup_token_created_at", now, now);
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.setupTokenPath, `${token}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(this.setupTokenPath, 0o600);
    } catch {
      // Best-effort on platforms that do not support POSIX modes.
    }
    this.log("auth.setup_token_created");
    console.info(`RoamCli setup token: ${token}`);
    return token;
  }

  private createRunnerToken(now: string): string {
    const token = randomToken();
    this.store.setAuthSetting("runner_token", token, now);
    this.store.setAuthSetting("runner_token_created_at", now, now);
    this.store.setAuthSetting("runner_token_updated_at", now, now);
    return token;
  }

  private createSession(request: FastifyRequest): {
    record: AuthSessionRecord;
    token: string;
  } {
    const now = Date.now();
    const token = randomToken();
    const record: AuthSessionRecord = {
      id: newId("auth_session"),
      tokenHash: hashSecret(token),
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      absoluteExpiresAt: new Date(now + ABSOLUTE_TIMEOUT_MS).toISOString(),
      ...(request.headers["user-agent"]
        ? { userAgent: String(request.headers["user-agent"]).slice(0, 240) }
        : {}),
      ...(request.ip ? { ipHash: hashSecret(request.ip).slice(0, 24) } : {}),
    };
    this.store.createAuthSession(record);
    return { record, token };
  }

  private rateKey(kind: string, request: FastifyRequest): string {
    return `${kind}:ip:${request.ip ? hashSecret(request.ip).slice(0, 24) : "unknown"}`;
  }

  private isRateLimited(key: string): boolean {
    const state = this.attempts.get(key);
    return Boolean(state && state.blockedUntil > Date.now());
  }

  private recordFailure(key: string): void {
    const current = this.attempts.get(key) ?? { count: 0, blockedUntil: 0 };
    const count = current.count + 1;
    const blockedUntil = Date.now() + blockDurationMs(count);
    this.attempts.set(key, { count, blockedUntil });
  }

  private recordSuccess(key: string): void {
    this.attempts.delete(key);
  }

  private log(
    event: string,
    request?: FastifyRequest,
    sessionId?: string,
  ): void {
    console.info(
      JSON.stringify({
        timestamp: nowIso(),
        event,
        ...(request?.ip
          ? { ipHash: hashSecret(request.ip).slice(0, 24) }
          : {}),
        ...(request?.headers["user-agent"]
          ? { userAgent: String(request.headers["user-agent"]).slice(0, 120) }
          : {}),
        ...(sessionId ? { sessionId } : {}),
      }),
    );
  }
}

function hashPassword(password: string): PasswordRecord {
  const salt = randomToken();
  const key = scryptSync(password, salt, PASSWORD_KEY_LENGTH, SCRYPT_PARAMS);
  return {
    alg: "scrypt",
    salt,
    key: key.toString("base64url"),
    keyLength: PASSWORD_KEY_LENGTH,
    ...SCRYPT_PARAMS,
  };
}

function verifyPassword(password: string, record: PasswordRecord): boolean {
  if (record.alg !== "scrypt") {
    return false;
  }
  const key = scryptSync(password, record.salt, record.keyLength, {
    N: record.N,
    r: record.r,
    p: record.p,
  });
  return constantTimeEqualBytes(key, Buffer.from(record.key, "base64url"));
}

function toSessionSummary(
  session: AuthSessionRecord,
  currentSessionId?: string,
): AuthSessionSummary {
  return {
    id: session.id,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    idleExpiresAt: new Date(
      Date.parse(session.lastSeenAt) + IDLE_TIMEOUT_MS,
    ).toISOString(),
    absoluteExpiresAt: session.absoluteExpiresAt,
    ...(session.userAgent ? { userAgent: session.userAgent } : {}),
    ...(session.ipHash ? { ipHash: session.ipHash } : {}),
    current: session.id === currentSessionId,
  };
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  return constantTimeEqualBytes(Buffer.from(a), Buffer.from(b));
}

function constantTimeEqualBytes(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

function blockDurationMs(count: number): number {
  if (count >= 20) return 15 * 60 * 1000;
  if (count >= 10) return 5 * 60 * 1000;
  if (count >= 5) return 60 * 1000;
  return 0;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return undefined;
}

function serializeCookie(
  name: string,
  value: string,
  options: {
    httpOnly: boolean;
    sameSite: "Strict";
    path: string;
    maxAge: number;
    secure: boolean;
  },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    `SameSite=${options.sameSite}`,
  ];
  if (options.httpOnly) {
    parts.push("HttpOnly");
  }
  if (options.secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function isSecureRequest(request: FastifyRequest): boolean {
  const forwardedProto = request.headers["x-forwarded-proto"];
  if (typeof forwardedProto === "string") {
    return forwardedProto.split(",")[0]?.trim() === "https";
  }
  return request.protocol === "https";
}

function removeFileIfExists(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Best-effort cleanup only.
  }
}
