import {
  setPrivateMode,
  syncDirectoryHandle,
  renameWithRetry,
} from "../platform/filesystem.js";
import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, unlink, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface AuditRecord<TPayload = unknown> {
  sequence: number;
  timestamp: string;
  kind: string;
  payload: TPayload;
  previousHash: string;
  hash: string;
}

interface AuditState {
  readonly sequence: number;
  readonly lastHash: string;
  readonly lastRecordOffset: bigint;
  readonly lastRecordLength: number;
}

interface VerifiedAuditState extends AuditState {
  readonly log: AuditFileMetadata;
}

interface AuditFileMetadata {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

interface AuditCheckpointBase {
  readonly version: 1;
  readonly log: AuditFileMetadata;
  readonly sequence: number;
  readonly lastHash: string;
  readonly lastRecordOffset: string;
  readonly lastRecordLength: number;
}

interface AuditCheckpoint extends AuditCheckpointBase {
  readonly checkpointHash: string;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface LockOwner {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
  readonly createdAt: string;
}

interface InspectedLock {
  readonly identity: FileIdentity;
  readonly modifiedAtMs: number;
  readonly owner?: LockOwner;
}

interface HeldLock {
  readonly owner: LockOwner;
  release(): Promise<void>;
}

const INITIAL_HASH = "0".repeat(64);
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | NO_FOLLOW;
const LOCK_RETRY_BASE_MS = 4;
const LOCK_WAIT_TIMEOUT_MS = 30_000;
const MALFORMED_LOCK_STALE_MS = 5_000;
const MAX_LOCK_BYTES = 4_096;
const MAX_CHECKPOINT_BYTES = 8_192;
const MAX_CHECKPOINT_TAIL_BYTES = 16 * 1024 * 1024;
const CHECKPOINT_VERSION = 1;

export class AuditLog {
  readonly #path: string;
  #lastHash = INITIAL_HASH;
  #sequence = 0;
  #appendTail: Promise<void> = Promise.resolve();

  public constructor(path: string) {
    this.#path = resolve(path);
  }

  public async append<TPayload>(
    kind: string,
    payload: TPayload,
  ): Promise<AuditRecord<TPayload>> {
    const operation = this.#appendTail.then(() =>
      this.#appendRecord(kind, payload),
    );
    this.#appendTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #appendRecord<TPayload>(
    kind: string,
    payload: TPayload,
  ): Promise<AuditRecord<TPayload>> {
    return withAuditLock(this.#path, async (directoryIdentity) => {
      const file = await openAuditFile(this.#path, directoryIdentity, true);
      if (file === undefined) {
        throw new Error("Failed to create the audit log");
      }
      try {
        const state = await loadAuditStateForAppend(
          this.#path,
          file,
          directoryIdentity,
        );
        const beforeAppend = await file.stat({ bigint: true });
        if (
          !sameAuditFileMetadata(state.log, auditFileMetadata(beforeAppend))
        ) {
          throw new Error("Audit log changed after integrity verification");
        }
        const base = {
          sequence: state.sequence + 1,
          timestamp: new Date().toISOString(),
          kind,
          payload,
          previousHash: state.lastHash,
        };
        const hash = hashAuditBase(base);
        const record: AuditRecord<TPayload> = { ...base, hash };
        const serialized = `${JSON.stringify(record)}\n`;
        const serializedLength = Buffer.byteLength(serialized);
        await file.writeFile(serialized, "utf8");
        await file.sync();
        const afterAppend = await file.stat({ bigint: true });
        if (afterAppend.size !== beforeAppend.size + BigInt(serializedLength)) {
          throw new Error("Audit log size changed unexpectedly during append");
        }
        await assertPathIdentity(this.#path, afterAppend, "audit log");
        await writeAuditCheckpoint(
          this.#path,
          directoryIdentity,
          checkpointFor(
            {
              sequence: record.sequence,
              lastHash: record.hash,
              lastRecordOffset: beforeAppend.size,
              lastRecordLength: serializedLength,
            },
            afterAppend,
          ),
        );
        this.#sequence = record.sequence;
        this.#lastHash = record.hash;
        return record;
      } finally {
        await file.close();
      }
    });
  }

  public async lastHash(): Promise<string> {
    const pendingAppends = this.#appendTail;
    await pendingAppends;
    await this.#refresh();
    return this.#lastHash;
  }

  async #refresh(): Promise<void> {
    const state = await withAuditLock(this.#path, async (directoryIdentity) => {
      const file = await openAuditFile(this.#path, directoryIdentity, false);
      if (file === undefined) {
        await assertCheckpointSidecarsSafe(this.#path, directoryIdentity);
        return emptyAuditState();
      }
      try {
        await assertCheckpointSidecarsSafe(this.#path, directoryIdentity);
        const beforeRead = await file.stat({ bigint: true });
        const state = parseAuditContent(await file.readFile("utf8"));
        const info = await file.stat({ bigint: true });
        if (
          !sameAuditFileMetadata(
            auditFileMetadata(beforeRead),
            auditFileMetadata(info),
          )
        ) {
          throw new Error(
            "Audit log changed during full integrity verification",
          );
        }
        await assertPathIdentity(this.#path, info, "audit log");
        await writeAuditCheckpoint(
          this.#path,
          directoryIdentity,
          checkpointFor(state, info),
        );
        const afterCheckpoint = await file.stat({ bigint: true });
        if (
          !sameAuditFileMetadata(
            auditFileMetadata(info),
            auditFileMetadata(afterCheckpoint),
          )
        ) {
          throw new Error(
            "Audit log changed after full integrity verification",
          );
        }
        return state;
      } finally {
        await file.close();
      }
    });
    this.#sequence = state.sequence;
    this.#lastHash = state.lastHash;
  }
}

async function loadAuditStateForAppend(
  auditPath: string,
  file: FileHandle,
  directoryIdentity: FileIdentity,
): Promise<VerifiedAuditState> {
  await assertCheckpointSidecarsSafe(auditPath, directoryIdentity);
  const checkpoint = await readAuditCheckpoint(auditPath, directoryIdentity);
  if (checkpoint !== undefined) {
    const info = await file.stat({ bigint: true });
    if (sameAuditFileMetadata(checkpoint.log, auditFileMetadata(info))) {
      const checkpointState = await validateCheckpointTail(file, checkpoint);
      if (checkpointState !== undefined) {
        return checkpointState;
      }
    }
  }

  const beforeRead = await file.stat({ bigint: true });
  const state = parseAuditContent(await file.readFile("utf8"));
  const afterRead = await file.stat({ bigint: true });
  if (
    !sameAuditFileMetadata(
      auditFileMetadata(beforeRead),
      auditFileMetadata(afterRead),
    )
  ) {
    throw new Error("Audit log changed during full integrity verification");
  }
  await assertPathIdentity(auditPath, afterRead, "audit log");
  await writeAuditCheckpoint(
    auditPath,
    directoryIdentity,
    checkpointFor(state, afterRead),
  );
  return { ...state, log: auditFileMetadata(afterRead) };
}

async function validateCheckpointTail(
  file: FileHandle,
  checkpoint: AuditCheckpoint,
): Promise<VerifiedAuditState | undefined> {
  const info = await file.stat({ bigint: true });
  if (!sameAuditFileMetadata(checkpoint.log, auditFileMetadata(info))) {
    return undefined;
  }
  if (checkpoint.sequence === 0) {
    if (
      info.size !== 0n ||
      checkpoint.lastHash !== INITIAL_HASH ||
      checkpoint.lastRecordOffset !== "0" ||
      checkpoint.lastRecordLength !== 0
    ) {
      return undefined;
    }
    return { ...emptyAuditState(), log: auditFileMetadata(info) };
  }

  const offset = BigInt(checkpoint.lastRecordOffset);
  const length = checkpoint.lastRecordLength;
  if (
    length <= 0 ||
    length > MAX_CHECKPOINT_TAIL_BYTES ||
    offset + BigInt(length) !== info.size
  ) {
    return undefined;
  }

  const serialized = Buffer.alloc(length);
  const { bytesRead } = await file.read(serialized, 0, length, offset);
  if (bytesRead !== length) {
    return undefined;
  }
  const afterRead = await file.stat({ bigint: true });
  if (!sameAuditFileMetadata(checkpoint.log, auditFileMetadata(afterRead))) {
    return undefined;
  }

  const content = serialized.toString("utf8");
  if (!content.endsWith("\n") || content.slice(0, -1).includes("\n")) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(0, -1));
  } catch {
    return undefined;
  }
  if (
    !isAuditRecord(parsed) ||
    parsed.sequence !== checkpoint.sequence ||
    parsed.hash !== checkpoint.lastHash
  ) {
    return undefined;
  }
  const { hash, ...base } = parsed;
  if (hashAuditBase(base) !== hash) {
    return undefined;
  }
  return {
    sequence: checkpoint.sequence,
    lastHash: checkpoint.lastHash,
    lastRecordOffset: offset,
    lastRecordLength: length,
    log: auditFileMetadata(afterRead),
  };
}

async function readAuditCheckpoint(
  auditPath: string,
  directoryIdentity: FileIdentity,
): Promise<AuditCheckpoint | undefined> {
  const path = checkpointPath(auditPath);
  const pathInfo = await inspectCheckpointSidecar(path, "audit checkpoint");
  if (pathInfo === undefined) {
    return undefined;
  }

  let file: FileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | NO_FOLLOW);
    let info = await file.stat({ bigint: true });
    assertPrivateRegularFile(info, path, "audit checkpoint");
    if ((Number(info.mode) & 0o777) !== 0o600) {
      await setPrivateMode(file, path, 0o600);
      info = await file.stat({ bigint: true });
    }
    await assertDirectoryIdentity(dirname(path), directoryIdentity);
    await assertPathIdentity(path, info, "audit checkpoint");
    if (info.size > BigInt(MAX_CHECKPOINT_BYTES)) {
      return undefined;
    }
    const content = await file.readFile("utf8");
    const afterRead = await file.stat({ bigint: true });
    if (
      !sameAuditFileMetadata(
        auditFileMetadata(info),
        auditFileMetadata(afterRead),
      )
    ) {
      throw new Error("Audit checkpoint changed while it was being read");
    }
    await assertPathIdentity(path, afterRead, "audit checkpoint");
    return parseAuditCheckpoint(content);
  } catch (error) {
    if (isSymlinkOpenError(error)) {
      throw symlinkError(path, "audit checkpoint", error);
    }
    throw error;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function writeAuditCheckpoint(
  auditPath: string,
  directoryIdentity: FileIdentity,
  checkpoint: AuditCheckpoint,
): Promise<void> {
  const path = checkpointPath(auditPath);
  const temporaryPath = checkpointTemporaryPath(auditPath);
  await assertCheckpointSidecarsSafe(auditPath, directoryIdentity);
  await removeStaleCheckpointTemporaryFile(temporaryPath);

  const serialized = `${JSON.stringify(checkpoint)}\n`;
  if (Buffer.byteLength(serialized) > MAX_CHECKPOINT_BYTES) {
    throw new Error("Audit checkpoint exceeds its maximum size");
  }

  let file: FileHandle | undefined;
  let temporaryIdentity: FileIdentity | undefined;
  let renamed = false;
  try {
    file = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    const created = await file.stat({ bigint: true });
    assertPrivateRegularFile(
      created,
      temporaryPath,
      "audit checkpoint temporary file",
    );
    temporaryIdentity = identityOf(created);
    await setPrivateMode(file, temporaryPath, 0o600);
    await file.writeFile(serialized, "utf8");
    await file.sync();
    const written = await file.stat({ bigint: true });
    assertPrivateRegularFile(
      written,
      temporaryPath,
      "audit checkpoint temporary file",
    );
    await assertDirectoryIdentity(dirname(path), directoryIdentity);
    await assertPathIdentity(
      temporaryPath,
      written,
      "audit checkpoint temporary file",
    );
    await inspectCheckpointSidecar(path, "audit checkpoint");
    await renameWithRetry(temporaryPath, path);
    renamed = true;
    await assertPathIdentity(path, written, "audit checkpoint");
    await syncDirectory(dirname(path), directoryIdentity);
  } catch (error) {
    if (isSymlinkOpenError(error)) {
      throw symlinkError(
        temporaryPath,
        "audit checkpoint temporary file",
        error,
      );
    }
    throw error;
  } finally {
    await file?.close().catch(() => undefined);
    if (!renamed && temporaryIdentity !== undefined) {
      await removeSidecarIfUnchanged(
        temporaryPath,
        temporaryIdentity,
        "audit checkpoint temporary file",
      ).catch(() => undefined);
    }
  }
}

async function assertCheckpointSidecarsSafe(
  auditPath: string,
  directoryIdentity: FileIdentity,
): Promise<void> {
  await assertDirectoryIdentity(dirname(auditPath), directoryIdentity);
  await inspectCheckpointSidecar(checkpointPath(auditPath), "audit checkpoint");
  await inspectCheckpointSidecar(
    checkpointTemporaryPath(auditPath),
    "audit checkpoint temporary file",
  );
}

async function inspectCheckpointSidecar(
  path: string,
  label: string,
): Promise<BigIntStats | undefined> {
  let info: BigIntStats;
  try {
    info = await lstat(path, { bigint: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  assertNotSymlink(info, path, label);
  assertPrivateRegularFile(info, path, label);
  return info;
}

async function removeStaleCheckpointTemporaryFile(path: string): Promise<void> {
  const existing = await inspectCheckpointSidecar(
    path,
    "audit checkpoint temporary file",
  );
  if (existing === undefined) {
    return;
  }
  const removed = await removeSidecarIfUnchanged(
    path,
    identityOf(existing),
    "audit checkpoint temporary file",
  );
  if (!removed) {
    throw new Error("Audit checkpoint temporary file changed during cleanup");
  }
}

async function removeSidecarIfUnchanged(
  path: string,
  expected: FileIdentity,
  label: string,
): Promise<boolean> {
  const current = await inspectCheckpointSidecar(path, label);
  if (current === undefined || !sameIdentity(identityOf(current), expected)) {
    return false;
  }
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function syncDirectory(
  path: string,
  expected: FileIdentity,
): Promise<void> {
  const directory = await open(path, DIRECTORY_FLAGS);
  try {
    const info = await directory.stat({ bigint: true });
    if (!info.isDirectory() || !sameIdentity(identityOf(info), expected)) {
      throw new Error(`Audit directory changed during operation: ${path}`);
    }
    await syncDirectoryHandle(directory);
    await assertDirectoryIdentity(path, expected);
  } finally {
    await directory.close();
  }
}

function checkpointFor(state: AuditState, info: BigIntStats): AuditCheckpoint {
  const base: AuditCheckpointBase = {
    version: CHECKPOINT_VERSION,
    log: auditFileMetadata(info),
    sequence: state.sequence,
    lastHash: state.lastHash,
    lastRecordOffset: state.lastRecordOffset.toString(),
    lastRecordLength: state.lastRecordLength,
  };
  return { ...base, checkpointHash: hashCheckpointBase(base) };
}

function parseAuditCheckpoint(content: string): AuditCheckpoint | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isAuditCheckpointShape(value)) {
    return undefined;
  }
  const base: AuditCheckpointBase = {
    version: value.version,
    log: value.log,
    sequence: value.sequence,
    lastHash: value.lastHash,
    lastRecordOffset: value.lastRecordOffset,
    lastRecordLength: value.lastRecordLength,
  };
  if (hashCheckpointBase(base) !== value.checkpointHash) {
    return undefined;
  }
  return { ...base, checkpointHash: value.checkpointHash };
}

function isAuditCheckpointShape(value: unknown): value is AuditCheckpoint {
  if (
    value === null ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== CHECKPOINT_VERSION ||
    !("log" in value) ||
    !isAuditFileMetadata(value.log) ||
    !("sequence" in value) ||
    typeof value.sequence !== "number" ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 0 ||
    !("lastHash" in value) ||
    typeof value.lastHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.lastHash) ||
    !("lastRecordOffset" in value) ||
    typeof value.lastRecordOffset !== "string" ||
    !/^\d+$/.test(value.lastRecordOffset) ||
    !("lastRecordLength" in value) ||
    typeof value.lastRecordLength !== "number" ||
    !Number.isSafeInteger(value.lastRecordLength) ||
    value.lastRecordLength < 0 ||
    value.lastRecordLength > MAX_CHECKPOINT_TAIL_BYTES ||
    !("checkpointHash" in value) ||
    typeof value.checkpointHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.checkpointHash)
  ) {
    return false;
  }
  return value.sequence === 0
    ? value.lastHash === INITIAL_HASH &&
        value.lastRecordOffset === "0" &&
        value.lastRecordLength === 0
    : value.lastRecordLength > 0;
}

function isAuditFileMetadata(value: unknown): value is AuditFileMetadata {
  return (
    value !== null &&
    typeof value === "object" &&
    "dev" in value &&
    typeof value.dev === "string" &&
    /^\d+$/.test(value.dev) &&
    "ino" in value &&
    typeof value.ino === "string" &&
    /^\d+$/.test(value.ino) &&
    "size" in value &&
    typeof value.size === "string" &&
    /^\d+$/.test(value.size) &&
    "mtimeNs" in value &&
    typeof value.mtimeNs === "string" &&
    /^\d+$/.test(value.mtimeNs) &&
    "ctimeNs" in value &&
    typeof value.ctimeNs === "string" &&
    /^\d+$/.test(value.ctimeNs)
  );
}

function auditFileMetadata(info: BigIntStats): AuditFileMetadata {
  return {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    size: info.size.toString(),
    mtimeNs: info.mtimeNs.toString(),
    ctimeNs: info.ctimeNs.toString(),
  };
}

function sameAuditFileMetadata(
  left: AuditFileMetadata,
  right: AuditFileMetadata,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function checkpointPath(auditPath: string): string {
  return `${auditPath}.checkpoint`;
}

function checkpointTemporaryPath(auditPath: string): string {
  return `${checkpointPath(auditPath)}.tmp`;
}

function hashCheckpointBase(value: AuditCheckpointBase): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function emptyAuditState(): AuditState {
  return {
    sequence: 0,
    lastHash: INITIAL_HASH,
    lastRecordOffset: 0n,
    lastRecordLength: 0,
  };
}

async function withAuditLock<T>(
  auditPath: string,
  operation: (directoryIdentity: FileIdentity) => Promise<T>,
): Promise<T> {
  const directoryIdentity = await ensurePrivateDirectory(dirname(auditPath));
  const heldLock = await acquireLock(`${auditPath}.lock`, directoryIdentity);
  try {
    return await operation(directoryIdentity);
  } finally {
    await heldLock.release();
  }
}

async function ensurePrivateDirectory(path: string): Promise<FileIdentity> {
  try {
    const info = await lstat(path, { bigint: true });
    assertNotSymlink(info, path, "audit directory");
    if (!info.isDirectory()) {
      throw new Error(`Audit directory is not a directory: ${path}`);
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
    await mkdir(path, { recursive: true, mode: 0o700 });
  }

  let directory: FileHandle | undefined;
  try {
    directory = await open(path, DIRECTORY_FLAGS);
    const info = await directory.stat({ bigint: true });
    if (!info.isDirectory()) {
      throw new Error(`Audit directory is not a directory: ${path}`);
    }
    await setPrivateMode(directory, path, 0o700);
    await assertPathIdentity(path, info, "audit directory");
    return identityOf(info);
  } catch (error) {
    if (isSymlinkOpenError(error)) {
      throw symlinkError(path, "audit directory", error);
    }
    throw error;
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

async function openAuditFile(
  path: string,
  directoryIdentity: FileIdentity,
  create: boolean,
): Promise<FileHandle | undefined> {
  await assertDirectoryIdentity(dirname(path), directoryIdentity);
  await assertLeafIsNotSymlink(path, "audit log");
  const flags = create
    ? constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | NO_FOLLOW
    : constants.O_RDONLY | NO_FOLLOW;
  let file: FileHandle | undefined;
  try {
    file = await open(path, flags, 0o600);
  } catch (error) {
    if (!create && isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    if (isSymlinkOpenError(error)) {
      throw symlinkError(path, "audit log", error);
    }
    throw error;
  }

  try {
    let info = await file.stat({ bigint: true });
    if (!info.isFile() || info.nlink !== 1n) {
      throw new Error(`Audit log is not a private regular file: ${path}`);
    }
    if ((Number(info.mode) & 0o777) !== 0o600) {
      await setPrivateMode(file, path, 0o600);
      info = await file.stat({ bigint: true });
    }
    await assertDirectoryIdentity(dirname(path), directoryIdentity);
    await assertPathIdentity(path, info, "audit log");
    return file;
  } catch (error) {
    await file.close().catch(() => undefined);
    throw error;
  }
}

async function acquireLock(
  path: string,
  directoryIdentity: FileIdentity,
): Promise<HeldLock> {
  const reaperPath = `${path}.reaper`;
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  let attempt = 0;
  while (true) {
    await assertDirectoryIdentity(dirname(path), directoryIdentity);
    const reaper = await inspectLock(reaperPath, "audit lock reaper");
    if (reaper !== undefined) {
      if (isStaleLock(reaper)) {
        await removeLockIfUnchanged(reaperPath, reaper, "audit lock reaper");
        continue;
      }
      await waitForLock(deadline, attempt++);
      continue;
    }

    const owner = createLockOwner();
    try {
      const file = await createLockFile(
        path,
        owner,
        directoryIdentity,
        "audit lock",
      );
      return {
        owner,
        release: async () => {
          try {
            const current = await inspectLock(path, "audit lock");
            if (current?.owner?.token !== owner.token) {
              throw new Error("Audit lock ownership changed before release");
            }
            await removeLockIfUnchanged(path, current, "audit lock");
          } finally {
            await file.close().catch(() => undefined);
          }
        },
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
    }

    const existing = await inspectLock(path, "audit lock");
    if (existing === undefined) {
      continue;
    }
    if (isStaleLock(existing)) {
      await reapStaleLock(path, reaperPath, existing, directoryIdentity);
      continue;
    }
    await waitForLock(deadline, attempt++);
  }
}

async function reapStaleLock(
  path: string,
  reaperPath: string,
  staleLock: InspectedLock,
  directoryIdentity: FileIdentity,
): Promise<void> {
  const owner = createLockOwner();
  let reaper: FileHandle;
  try {
    reaper = await createLockFile(
      reaperPath,
      owner,
      directoryIdentity,
      "audit lock reaper",
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return;
    }
    throw error;
  }

  try {
    const current = await inspectLock(path, "audit lock");
    if (
      current !== undefined &&
      sameIdentity(current.identity, staleLock.identity) &&
      current.owner?.token === staleLock.owner?.token &&
      isStaleLock(current)
    ) {
      await removeLockIfUnchanged(path, current, "audit lock");
    }
  } finally {
    try {
      const currentReaper = await inspectLock(reaperPath, "audit lock reaper");
      if (currentReaper?.owner?.token === owner.token) {
        await removeLockIfUnchanged(
          reaperPath,
          currentReaper,
          "audit lock reaper",
        );
      }
    } finally {
      await reaper.close().catch(() => undefined);
    }
  }
}

async function createLockFile(
  path: string,
  owner: LockOwner,
  directoryIdentity: FileIdentity,
  label: string,
): Promise<FileHandle> {
  await assertDirectoryIdentity(dirname(path), directoryIdentity);
  await assertLeafIsNotSymlink(path, label);
  let file: FileHandle | undefined;
  try {
    file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || info.nlink !== 1n) {
      throw new Error(`${capitalize(label)} is not a private regular file`);
    }
    await setPrivateMode(file, path, 0o600);
    await file.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await file.sync();
    await assertDirectoryIdentity(dirname(path), directoryIdentity);
    await assertPathIdentity(path, info, label);
    return file;
  } catch (error) {
    await file?.close().catch(() => undefined);
    if (isSymlinkOpenError(error)) {
      throw symlinkError(path, label, error);
    }
    throw error;
  }
}

async function inspectLock(
  path: string,
  label: string,
): Promise<InspectedLock | undefined> {
  let pathInfo: BigIntStats;
  try {
    pathInfo = await lstat(path, { bigint: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  assertNotSymlink(pathInfo, path, label);
  if (pathInfo.nlink === 0n) {
    return undefined;
  }
  if (!pathInfo.isFile() || pathInfo.nlink > 1n) {
    throw new Error(
      `${capitalize(label)} is not a private regular file: ${path}`,
    );
  }

  let file: FileHandle | undefined;
  try {
    file = await open(path, constants.O_RDONLY | NO_FOLLOW);
    const info = await file.stat({ bigint: true });
    if (info.nlink === 0n) {
      return undefined;
    }
    if (!info.isFile() || info.nlink > 1n) {
      throw new Error(
        `${capitalize(label)} is not a private regular file: ${path}`,
      );
    }
    await assertPathIdentity(path, info, label);
    if (info.size > MAX_LOCK_BYTES) {
      return {
        identity: identityOf(info),
        modifiedAtMs: Number(info.mtimeMs),
      };
    }
    const content = await file.readFile("utf8");
    const owner = parseLockOwner(content);
    const inspected = {
      identity: identityOf(info),
      modifiedAtMs: Number(info.mtimeMs),
    };
    return owner === undefined ? inspected : { ...inspected, owner };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    if (isSymlinkOpenError(error)) {
      throw symlinkError(path, label, error);
    }
    throw error;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function removeLockIfUnchanged(
  path: string,
  expected: InspectedLock,
  label: string,
): Promise<boolean> {
  const current = await inspectLock(path, label);
  if (
    current === undefined ||
    !sameIdentity(current.identity, expected.identity) ||
    current.owner?.token !== expected.owner?.token
  ) {
    return false;
  }
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function waitForLock(deadline: number, attempt: number): Promise<void> {
  if (Date.now() >= deadline) {
    throw new Error("Timed out waiting for the audit log lock");
  }
  const cappedAttempt = Math.min(attempt, 8);
  const jitter = Math.floor(Math.random() * LOCK_RETRY_BASE_MS);
  const delay = Math.min(100, LOCK_RETRY_BASE_MS * 2 ** cappedAttempt + jitter);
  await new Promise<void>((resolveDelay) => {
    setTimeout(resolveDelay, delay);
  });
}

function isStaleLock(lock: InspectedLock): boolean {
  if (lock.owner !== undefined) {
    return !isProcessAlive(lock.owner.pid);
  }
  return Date.now() - lock.modifiedAtMs >= MALFORMED_LOCK_STALE_MS;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error) || error.code !== "ESRCH";
  }
}

function createLockOwner(): LockOwner {
  return {
    version: 1,
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };
}

function parseLockOwner(content: string): LockOwner | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("version" in parsed) ||
    parsed.version !== 1 ||
    !("pid" in parsed) ||
    typeof parsed.pid !== "number" ||
    !Number.isSafeInteger(parsed.pid) ||
    parsed.pid <= 0 ||
    !("token" in parsed) ||
    typeof parsed.token !== "string" ||
    parsed.token.length < 8 ||
    !("createdAt" in parsed) ||
    typeof parsed.createdAt !== "string" ||
    Number.isNaN(Date.parse(parsed.createdAt))
  ) {
    return undefined;
  }
  return parsed as LockOwner;
}

function parseAuditContent(content: string): AuditState {
  if (content.length === 0) {
    return emptyAuditState();
  }
  if (!content.endsWith("\n")) {
    throw auditIntegrityError(
      content.split("\n").length,
      "unterminated record",
    );
  }

  let sequence = 0;
  let lastHash = INITIAL_HASH;
  const lines = content.slice(0, -1).split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) {
      throw auditIntegrityError(index + 1, "empty record");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw auditIntegrityError(index + 1, "invalid JSON", error);
    }
    if (!isAuditRecord(parsed)) {
      throw auditIntegrityError(index + 1, "invalid record shape");
    }
    if (parsed.sequence !== sequence + 1) {
      throw auditIntegrityError(index + 1, "unexpected sequence");
    }
    if (parsed.previousHash !== lastHash) {
      throw auditIntegrityError(index + 1, "previous hash mismatch");
    }
    const { hash, ...base } = parsed;
    if (hashAuditBase(base) !== hash) {
      throw auditIntegrityError(index + 1, "hash mismatch");
    }
    sequence = parsed.sequence;
    lastHash = parsed.hash;
  }
  const lastRecordLength = Buffer.byteLength(lines.at(-1)!) + 1;
  return {
    sequence,
    lastHash,
    lastRecordOffset: BigInt(Buffer.byteLength(content) - lastRecordLength),
    lastRecordLength,
  };
}

async function assertLeafIsNotSymlink(
  path: string,
  label: string,
): Promise<void> {
  try {
    const info = await lstat(path, { bigint: true });
    assertNotSymlink(info, path, label);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function assertDirectoryIdentity(
  path: string,
  expected: FileIdentity,
): Promise<void> {
  const info = await lstat(path, { bigint: true });
  assertNotSymlink(info, path, "audit directory");
  if (!info.isDirectory() || !sameIdentity(identityOf(info), expected)) {
    throw new Error(`Audit directory changed during operation: ${path}`);
  }
}

async function assertPathIdentity(
  path: string,
  expected: BigIntStats,
  label: string,
): Promise<void> {
  const current = await lstat(path, { bigint: true });
  assertNotSymlink(current, path, label);
  if (!sameIdentity(identityOf(current), identityOf(expected))) {
    throw new Error(`${capitalize(label)} changed during operation: ${path}`);
  }
}

function assertNotSymlink(
  info: BigIntStats,
  path: string,
  label: string,
): void {
  if (info.isSymbolicLink()) {
    throw symlinkError(path, label);
  }
}

function assertPrivateRegularFile(
  info: BigIntStats,
  path: string,
  label: string,
): void {
  if (!info.isFile() || BigInt(info.nlink) !== 1n) {
    throw new Error(
      `${capitalize(label)} is not a private regular file: ${path}`,
    );
  }
}

function symlinkError(path: string, label: string, cause?: unknown): Error {
  return new Error(`${capitalize(label)} cannot be a symbolic link: ${path}`, {
    cause,
  });
}

function isSymlinkOpenError(error: unknown): boolean {
  return (
    isNodeError(error) && (error.code === "ELOOP" || error.code === "EMLINK")
  );
}

function identityOf(info: BigIntStats): FileIdentity {
  return { dev: BigInt(info.dev), ino: BigInt(info.ino) };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function isAuditRecord(value: unknown): value is AuditRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    "sequence" in value &&
    typeof value.sequence === "number" &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence > 0 &&
    "timestamp" in value &&
    typeof value.timestamp === "string" &&
    "kind" in value &&
    typeof value.kind === "string" &&
    "payload" in value &&
    "previousHash" in value &&
    typeof value.previousHash === "string" &&
    /^[a-f0-9]{64}$/.test(value.previousHash) &&
    "hash" in value &&
    typeof value.hash === "string" &&
    /^[a-f0-9]{64}$/.test(value.hash)
  );
}

function auditIntegrityError(
  line: number,
  reason: string,
  cause?: unknown,
): Error {
  return new Error(
    `Audit log integrity check failed at line ${line}: ${reason}`,
    { cause },
  );
}

function hashAuditBase(value: Omit<AuditRecord, "hash">): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
