import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { RunnerEventSchema, type RunnerEvent } from "@roamcli/shared/protocol";

export interface CachedRunnerEvent {
  id: string;
  createdAt: string;
  streamId: string;
  sequence: number;
  event: RunnerEvent;
}

export interface EventDeliveryState {
  streamId: string;
  acknowledgedThrough: number;
  nextSequence: number;
}

interface CacheHeader extends EventDeliveryState {
  kind: "runnerEventOutbox";
  version: 2;
}

interface PersistedEvent extends CachedRunnerEvent {
  kind: "event";
}

interface AckCheckpoint {
  kind: "ack";
  throughSequence: number;
}

interface LegacyDrainCheckpoint {
  kind: "legacyDrain";
  streamId: string;
  throughSequence: number;
}

interface CacheDocument {
  state: EventDeliveryState;
  entries: CachedRunnerEvent[];
  headIndex: number;
  staleRecords: number;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface CacheFileVersion extends FileIdentity {
  size: number;
  modifiedAtMs: number;
  changedAtMs: number;
}

export type EventCacheOperation = "read" | "append" | "replace";

export interface EventCacheOptions {
  onOperation?: (operation: EventCacheOperation) => void;
}

interface CacheLockOwner {
  version: 1;
  pid: number;
  token: string;
  createdAt: string;
}

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const LOCK_TIMEOUT_MS = 30_000;
const MALFORMED_LOCK_STALE_MS = 5_000;
const MIN_STALE_RECORDS_BEFORE_COMPACTION = 32;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface LegacyCachedRunnerEvent {
  id: string;
  createdAt: string;
  event: RunnerEvent;
  streamId?: unknown;
  sequence?: unknown;
}

export class EventCache {
  readonly #path: string;
  readonly #onOperation: (operation: EventCacheOperation) => void;
  readonly #ready: Promise<void>;
  #fileTail: Promise<void> = Promise.resolve();
  #drainTail: Promise<void> = Promise.resolve();
  #state?: EventDeliveryState;
  #document?: CacheDocument;
  #fileVersion?: CacheFileVersion;
  #snapshotRequired = false;

  public constructor(path: string, options: EventCacheOptions = {}) {
    this.#path = path;
    this.#onOperation = options.onOperation ?? (() => undefined);
    this.#ready = this.#initialize();
  }

  public async append(event: RunnerEvent): Promise<CachedRunnerEvent> {
    await this.#ready;
    return this.#withFileLock(async () => {
      const document = await this.#readDocument();
      const cached: CachedRunnerEvent = {
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        streamId: document.state.streamId,
        sequence: document.state.nextSequence,
        event,
      };
      await this.#appendRecord(`${JSON.stringify(toPersisted(cached))}\n`);
      document.entries.push(cached);
      const nextDocument: CacheDocument = {
        entries: document.entries,
        headIndex: document.headIndex,
        staleRecords: document.staleRecords,
        state: {
          ...document.state,
          nextSequence: cached.sequence + 1,
        },
      };
      this.#remember(nextDocument);
      this.#snapshotRequired = document.state.acknowledgedThrough === 0;
      return cached;
    });
  }

  public async deliveryState(): Promise<EventDeliveryState> {
    await this.#ready;
    return this.#withFileLock(async () => {
      const document = await this.#readDocument();
      this.#state = document.state;
      return { ...document.state };
    });
  }

  public async acknowledge(
    streamId: string,
    throughSequence: number,
  ): Promise<number> {
    await this.#ready;
    return this.#withFileLock(async () => {
      const document = await this.#readDocument();
      if (streamId !== document.state.streamId) {
        return 0;
      }
      if (throughSequence <= document.state.acknowledgedThrough) {
        return 0;
      }
      if (throughSequence >= document.state.nextSequence) {
        throw new Error(
          `Runner event ACK ${throughSequence} exceeds the last allocated sequence`,
        );
      }
      const expected = throughSequence - document.state.acknowledgedThrough;
      for (let index = 0; index < expected; index += 1) {
        if (
          document.entries[document.headIndex + index]?.sequence !==
          document.state.acknowledgedThrough + index + 1
        ) {
          throw new Error(
            `Runner event ACK ${throughSequence} does not cover a continuous local prefix`,
          );
        }
      }

      const nextDocument: CacheDocument = {
        state: {
          ...document.state,
          acknowledgedThrough: throughSequence,
        },
        entries: document.entries,
        headIndex: document.headIndex + expected,
        staleRecords: document.staleRecords + expected + 1,
      };
      if (
        this.#snapshotRequired ||
        nextDocument.headIndex === nextDocument.entries.length ||
        shouldCompact(nextDocument)
      ) {
        await this.#replaceDocument(nextDocument);
      } else {
        const checkpoint: AckCheckpoint = {
          kind: "ack",
          throughSequence,
        };
        await this.#appendRecord(`${JSON.stringify(checkpoint)}\n`);
        this.#remember(nextDocument);
      }
      return expected;
    });
  }

  /**
   * Sends raw events to a server that did not negotiate ACK delivery. A raw
   * success is the only point where the event is removed; the remaining
   * outbox is then moved to a fresh stream and re-sequenced for a future
   * ACK-capable connection.
   */
  public async drainLegacy(
    send: (event: RunnerEvent) => Promise<void>,
  ): Promise<number> {
    const operation = this.#drainTail.then(async () => {
      await this.#ready;
      const release = await acquireCacheLock(`${this.#path}.legacy-drain.lock`);
      try {
        return await this.#drainLegacyExclusive(send);
      } finally {
        await release();
      }
    });
    this.#drainTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async #drainLegacyExclusive(
    send: (event: RunnerEvent) => Promise<void>,
  ): Promise<number> {
    const deliveryIds = await this.#withFileLock(async () => {
      const document = await this.#readDocument();
      const entries = pendingEntries(document);
      if (entries.length === 0) {
        return [];
      }
      await this.#replaceDocument(document);
      await this.#appendLegacyDrainCheckpoint(
        document.state.streamId,
        document.state.acknowledgedThrough,
      );
      return entries.map((entry) => entry.id);
    });
    if (deliveryIds.length === 0) {
      return 0;
    }
    let sent = 0;
    try {
      for (const deliveryId of deliveryIds) {
        const head = await this.#withFileLock(async () =>
          headEntry(await this.#readDocument()),
        );
        if (head === undefined) {
          return sent;
        }
        if (head.id !== deliveryId) {
          throw new Error(
            "Runner legacy event outbox head changed during delivery",
          );
        }
        await send(head.event);
        await this.#withFileLock(async () => {
          const document = await this.#readDocument();
          if (headEntry(document)?.id !== head.id) {
            throw new Error(
              "Runner legacy event outbox head changed during delivery",
            );
          }
          await this.#appendLegacyDrainCheckpoint(head.streamId, head.sequence);
          document.headIndex += 1;
          document.staleRecords += 2;
          this.#remember(document);
        });
        sent += 1;
      }
      return sent;
    } finally {
      await this.#withFileLock(async () => {
        const document = await this.#readDocument();
        await this.#replaceDocument(rotateDocument(pendingEntries(document)));
      });
    }
  }

  /** @deprecated Only use for an explicitly negotiated legacy connection. */
  public drain(send: (event: RunnerEvent) => Promise<void>): Promise<number> {
    return this.drainLegacy(send);
  }

  public async readAll(): Promise<CachedRunnerEvent[]> {
    await this.#ready;
    return this.#withFileLock(async () => {
      const document = await this.#readDocument();
      this.#state = document.state;
      return pendingEntries(document);
    });
  }

  public async peek(): Promise<CachedRunnerEvent | undefined> {
    await this.#ready;
    return this.#withFileLock(async () => {
      const document = await this.#readDocument();
      this.#state = document.state;
      return headEntry(document);
    });
  }

  #withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#fileTail.then(() =>
      withCacheLock(this.#path, operation),
    );
    this.#fileTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #initialize(): Promise<void> {
    await withCacheLock(this.#path, async () => {
      await assertRegularFileOrMissing(this.#path);
      const drainingPaths = await legacyDrainingPaths(this.#path);
      const main = await readCacheLines(this.#path);
      const legacyEntries: LegacyCachedRunnerEvent[] = [];
      for (const path of drainingPaths) {
        const draining = await readCacheLines(path);
        legacyEntries.push(...draining.legacyEntries, ...draining.events);
      }
      legacyEntries.push(...main.legacyEntries);

      const mainDocument =
        main.header === undefined ? undefined : documentFromLines(main);
      let document: CacheDocument;
      if (
        mainDocument !== undefined &&
        legacyEntries.length === 0 &&
        main.legacyDrainCheckpoints.length === 0
      ) {
        document = mainDocument;
      } else {
        const entries = deduplicateLegacyEntries([
          ...legacyEntries,
          ...(mainDocument === undefined
            ? main.events
            : pendingEntries(mainDocument)),
        ]);
        document = rotateDocument(entries);
      }

      await this.#replaceDocument(document);
      await Promise.all(drainingPaths.map((path) => rm(path, { force: true })));
      if (drainingPaths.length > 0) {
        await syncDirectory(dirname(this.#path));
      }
      this.#remember(document);
    });
  }

  async #readDocument(): Promise<CacheDocument> {
    const fileVersion = await cacheFileVersion(this.#path);
    if (
      this.#document !== undefined &&
      this.#fileVersion !== undefined &&
      sameFileVersion(fileVersion, this.#fileVersion)
    ) {
      return this.#document;
    }
    this.#onOperation("read");
    const lines = await readCacheLines(this.#path);
    if (lines.header === undefined) {
      throw new Error("Runner event outbox header is missing");
    }
    const document = documentFromLines(lines);
    if (lines.needsRepair) {
      await this.#replaceDocument(document);
    } else {
      this.#document = document;
      this.#fileVersion = fileVersion;
      this.#snapshotRequired =
        document.state.acknowledgedThrough === 0 &&
        lines.header.nextSequence !== document.state.nextSequence;
    }
    return document;
  }

  async #appendRecord(content: string): Promise<void> {
    this.#onOperation("append");
    await appendDurably(this.#path, content);
    this.#fileVersion = await cacheFileVersion(this.#path);
  }

  async #appendLegacyDrainCheckpoint(
    streamId: string,
    throughSequence: number,
  ): Promise<void> {
    const checkpoint: LegacyDrainCheckpoint = {
      kind: "legacyDrain",
      streamId,
      throughSequence,
    };
    await this.#appendRecord(`${JSON.stringify(checkpoint)}\n`);
  }

  async #replaceDocument(document: CacheDocument): Promise<void> {
    const normalized: CacheDocument = {
      state: document.state,
      entries: pendingEntries(document),
      headIndex: 0,
      staleRecords: 0,
    };
    this.#onOperation("replace");
    await replaceDurably(this.#path, serializeDocument(normalized));
    this.#document = normalized;
    this.#fileVersion = await cacheFileVersion(this.#path);
    this.#state = document.state;
    this.#snapshotRequired = false;
  }

  #remember(document: CacheDocument): void {
    this.#document = document;
    this.#state = document.state;
  }
}

interface ParsedCacheLines {
  header?: CacheHeader;
  events: CachedRunnerEvent[];
  checkpoints: AckCheckpoint[];
  legacyDrainCheckpoints: LegacyDrainCheckpoint[];
  legacyEntries: LegacyCachedRunnerEvent[];
  needsRepair: boolean;
}

async function readCacheLines(path: string): Promise<ParsedCacheLines> {
  const parsed: ParsedCacheLines = {
    events: [],
    checkpoints: [],
    legacyDrainCheckpoints: [],
    legacyEntries: [],
    needsRepair: false,
  };
  let content: string;
  try {
    content = await readUtf8NoFollow(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return parsed;
    }
    throw error;
  }

  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      const tornFinalLine =
        index === lines.length - 1 && !content.endsWith("\n");
      if (tornFinalLine) {
        parsed.needsRepair = true;
        break;
      }
      throw error;
    }
    if (isCacheHeader(value)) {
      if (parsed.header !== undefined) {
        throw new Error("Runner event outbox contains multiple headers");
      }
      parsed.header = value;
    } else if (isPersistedEvent(value)) {
      parsed.events.push(fromPersisted(value));
    } else if (isAckCheckpoint(value)) {
      parsed.checkpoints.push(value);
    } else if (isLegacyDrainCheckpoint(value)) {
      parsed.legacyDrainCheckpoints.push(value);
    } else if (isLegacyEntry(value)) {
      parsed.legacyEntries.push(value);
    } else {
      throw new Error("Runner event outbox contains an invalid record");
    }
  }
  if (content.length > 0 && !content.endsWith("\n")) {
    parsed.needsRepair = true;
  }
  return parsed;
}

function documentFromLines(lines: ParsedCacheLines): CacheDocument {
  const header = lines.header;
  if (header === undefined) {
    throw new Error("Runner event outbox header is missing");
  }
  if (lines.legacyEntries.length > 0) {
    throw new Error("Runner event outbox mixes legacy and ACK records");
  }
  const acknowledgedThrough = Math.max(
    header.acknowledgedThrough,
    ...lines.checkpoints.map((checkpoint) => checkpoint.throughSequence),
  );
  const events = lines.events;
  let expectedSequence = header.acknowledgedThrough + 1;
  for (const event of events) {
    if (
      event.streamId !== header.streamId ||
      event.sequence !== expectedSequence
    ) {
      throw new Error("Runner event outbox sequence is not continuous");
    }
    expectedSequence += 1;
  }
  if (header.nextSequence > expectedSequence) {
    throw new Error("Runner event outbox is missing an allocated sequence");
  }
  const nextSequence = expectedSequence;
  if (acknowledgedThrough >= nextSequence) {
    throw new Error("Runner event outbox ACK exceeds allocated sequences");
  }
  let legacyThrough = acknowledgedThrough;
  for (const [index, checkpoint] of lines.legacyDrainCheckpoints.entries()) {
    if (checkpoint.streamId !== header.streamId) {
      throw new Error("Runner legacy drain stream does not match the outbox");
    }
    const expectedThrough = index === 0 ? legacyThrough : legacyThrough + 1;
    if (
      checkpoint.throughSequence !== expectedThrough ||
      checkpoint.throughSequence >= nextSequence
    ) {
      throw new Error("Runner legacy drain progress is not continuous");
    }
    legacyThrough = checkpoint.throughSequence;
  }
  return {
    state: {
      streamId: header.streamId,
      acknowledgedThrough,
      nextSequence,
    },
    entries: events.filter((event) => event.sequence > legacyThrough),
    headIndex: 0,
    staleRecords:
      events.filter((event) => event.sequence <= legacyThrough).length +
      lines.checkpoints.length +
      lines.legacyDrainCheckpoints.length,
  };
}

function rotateDocument(
  entries: readonly (CachedRunnerEvent | LegacyCachedRunnerEvent)[],
): CacheDocument {
  const streamId = randomUUID();
  const normalized = entries.map((entry, index) => ({
    id: entry.id,
    createdAt: entry.createdAt,
    streamId,
    sequence: index + 1,
    event: entry.event,
  }));
  return {
    state: {
      streamId,
      acknowledgedThrough: 0,
      nextSequence: normalized.length + 1,
    },
    entries: normalized,
    headIndex: 0,
    staleRecords: 0,
  };
}

function serializeDocument(document: CacheDocument): string {
  const header: CacheHeader = {
    kind: "runnerEventOutbox",
    version: 2,
    ...document.state,
  };
  return `${[header, ...pendingEntries(document).map(toPersisted)]
    .map((record) => JSON.stringify(record))
    .join("\n")}\n`;
}

function headEntry(document: CacheDocument): CachedRunnerEvent | undefined {
  return document.entries[document.headIndex];
}

function pendingEntries(document: CacheDocument): CachedRunnerEvent[] {
  return document.entries.slice(document.headIndex);
}

function shouldCompact(document: CacheDocument): boolean {
  const liveEntries = document.entries.length - document.headIndex;
  return (
    document.staleRecords >= MIN_STALE_RECORDS_BEFORE_COMPACTION &&
    document.staleRecords >= liveEntries
  );
}

function toPersisted(entry: CachedRunnerEvent): PersistedEvent {
  return { kind: "event", ...entry };
}

function fromPersisted(entry: PersistedEvent): CachedRunnerEvent {
  const { kind: _kind, ...cached } = entry;
  return cached;
}

function deduplicateLegacyEntries(
  entries: readonly (LegacyCachedRunnerEvent | CachedRunnerEvent)[],
): Array<LegacyCachedRunnerEvent | CachedRunnerEvent> {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.id)) {
      return false;
    }
    seen.add(entry.id);
    return true;
  });
}

async function legacyDrainingPaths(path: string): Promise<string[]> {
  const directory = dirname(path);
  const fileName = basename(path);
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (
      entry.name.startsWith(`${fileName}.`) &&
      entry.name.endsWith(".draining")
    ) {
      if (!entry.isFile()) {
        throw new Error(
          `Runner event drain record is not a regular file: ${entry.name}`,
        );
      }
      paths.push(join(directory, entry.name));
    }
  }
  return paths.sort();
}

async function withCacheLock<T>(
  cachePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  await ensurePrivateDirectory(dirname(cachePath));
  const release = await acquireCacheLock(`${cachePath}.lock`);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function acquireCacheLock(path: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let attempt = 0;
  while (true) {
    const owner: CacheLockOwner = {
      version: 1,
      pid: process.pid,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    try {
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) {
        await handle.close();
        throw new Error(
          `Runner event outbox lock is not a private file: ${path}`,
        );
      }
      await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
      await handle.sync();
      return async () => {
        try {
          const current = await inspectCacheLock(path);
          if (
            current === undefined ||
            current.owner?.token !== owner.token ||
            !sameIdentity(current.identity, identityOf(info))
          ) {
            throw new Error("Runner event outbox lock ownership changed");
          }
          await unlink(path);
        } finally {
          await handle.close().catch(() => undefined);
        }
      };
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
    }

    const existing = await inspectCacheLock(path);
    if (existing === undefined) {
      continue;
    }
    if (isCacheLockStale(existing)) {
      const current = await inspectCacheLock(path);
      if (
        current !== undefined &&
        sameIdentity(current.identity, existing.identity) &&
        current.owner?.token === existing.owner?.token
      ) {
        await unlink(path).catch((error: unknown) => {
          if (!isNodeError(error) || error.code !== "ENOENT") {
            throw error;
          }
        });
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the runner event outbox lock");
    }
    const delay = Math.min(100, 4 * 2 ** Math.min(attempt, 8));
    attempt += 1;
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}

interface InspectedCacheLock {
  identity: FileIdentity;
  modifiedAtMs: number;
  owner?: CacheLockOwner;
}

async function inspectCacheLock(
  path: string,
): Promise<InspectedCacheLock | undefined> {
  let pathInfo;
  try {
    pathInfo = await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || pathInfo.nlink !== 1) {
    throw new Error(`Runner event outbox lock is not a private file: ${path}`);
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    if (info.nlink === 0) {
      return undefined;
    }
    if (!info.isFile() || info.nlink !== 1) {
      throw new Error(
        `Runner event outbox lock is not a private file: ${path}`,
      );
    }
    const content = info.size <= 4_096 ? await handle.readFile("utf8") : "";
    const owner = parseCacheLockOwner(content);
    const inspected = {
      identity: identityOf(info),
      modifiedAtMs: info.mtimeMs,
    };
    return owner === undefined ? inspected : { ...inspected, owner };
  } finally {
    await handle.close();
  }
}

function parseCacheLockOwner(content: string): CacheLockOwner | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isPositiveSafeInteger(value.pid) ||
    typeof value.token !== "string" ||
    value.token.length < 8 ||
    typeof value.createdAt !== "string"
  ) {
    return undefined;
  }
  return value as unknown as CacheLockOwner;
}

function isCacheLockStale(lock: InspectedCacheLock): boolean {
  if (lock.owner === undefined) {
    return Date.now() - lock.modifiedAtMs >= MALFORMED_LOCK_STALE_MS;
  }
  try {
    process.kill(lock.owner.pid, 0);
    return false;
  } catch (error) {
    return isNodeError(error) && error.code === "ESRCH";
  }
}

function identityOf(info: { dev: number; ino: number }): FileIdentity {
  return { dev: info.dev, ino: info.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileVersion(
  left: CacheFileVersion,
  right: CacheFileVersion,
): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.modifiedAtMs === right.modifiedAtMs &&
    left.changedAtMs === right.changedAtMs
  );
}

async function cacheFileVersion(path: string): Promise<CacheFileVersion> {
  const handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) {
      throw new Error(
        `Runner event outbox is not a private regular file: ${path}`,
      );
    }
    return {
      ...identityOf(info),
      size: info.size,
      modifiedAtMs: info.mtimeMs,
      changedAtMs: info.ctimeMs,
    };
  } finally {
    await handle.close();
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(
        `Runner state directory is not a real directory: ${path}`,
      );
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
    await mkdir(path, { recursive: true, mode: 0o700 });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(
        `Runner state directory is not a real directory: ${path}`,
      );
    }
  }
  await chmod(path, 0o700);
}

async function assertRegularFileOrMissing(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error(
        `Runner event outbox is not a private regular file: ${path}`,
      );
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function readUtf8NoFollow(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) {
      throw new Error(
        `Runner event outbox is not a private regular file: ${path}`,
      );
    }
    await handle.chmod(0o600);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

async function appendDurably(path: string, content: string): Promise<void> {
  await assertRegularFileOrMissing(path);
  const handle = await open(
    path,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) {
      throw new Error(
        `Runner event outbox is not a private regular file: ${path}`,
      );
    }
    await handle.chmod(0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceDurably(path: string, content: string): Promise<void> {
  await assertRegularFileOrMissing(path);
  const replacementPath = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.replacing`;
  let renamed = false;
  try {
    const handle = await open(
      replacementPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertRegularFileOrMissing(path);
    await rename(replacementPath, path);
    renamed = true;
    await syncDirectory(dirname(path));
  } finally {
    if (!renamed) {
      await rm(replacementPath, { force: true });
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isCacheHeader(value: unknown): value is CacheHeader {
  return (
    isRecord(value) &&
    value.kind === "runnerEventOutbox" &&
    value.version === 2 &&
    isUuid(value.streamId) &&
    isNonnegativeSafeInteger(value.acknowledgedThrough) &&
    isPositiveSafeInteger(value.nextSequence)
  );
}

function isPersistedEvent(value: unknown): value is PersistedEvent {
  return (
    isRecord(value) &&
    value.kind === "event" &&
    typeof value.id === "string" &&
    typeof value.createdAt === "string" &&
    isUuid(value.streamId) &&
    isPositiveSafeInteger(value.sequence) &&
    RunnerEventSchema.safeParse(value.event).success
  );
}

function isAckCheckpoint(value: unknown): value is AckCheckpoint {
  return (
    isRecord(value) &&
    value.kind === "ack" &&
    isNonnegativeSafeInteger(value.throughSequence)
  );
}

function isLegacyDrainCheckpoint(
  value: unknown,
): value is LegacyDrainCheckpoint {
  return (
    isRecord(value) &&
    value.kind === "legacyDrain" &&
    isUuid(value.streamId) &&
    isNonnegativeSafeInteger(value.throughSequence)
  );
}

function isLegacyEntry(value: unknown): value is LegacyCachedRunnerEvent {
  return (
    isRecord(value) &&
    value.kind === undefined &&
    typeof value.id === "string" &&
    typeof value.createdAt === "string" &&
    RunnerEventSchema.safeParse(value.event).success
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
