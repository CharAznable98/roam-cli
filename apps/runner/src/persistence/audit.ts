import { createHash } from "node:crypto";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface AuditRecord<TPayload = unknown> {
  sequence: number;
  timestamp: string;
  kind: string;
  payload: TPayload;
  previousHash: string;
  hash: string;
}

export class AuditLog {
  readonly #path: string;
  #lastHash = "0".repeat(64);
  #sequence = 0;
  #ready: Promise<void>;

  public constructor(path: string) {
    this.#path = path;
    this.#ready = this.#load();
  }

  public async append<TPayload>(kind: string, payload: TPayload): Promise<AuditRecord<TPayload>> {
    await this.#ready;
    const base = {
      sequence: this.#sequence + 1,
      timestamp: new Date().toISOString(),
      kind,
      payload,
      previousHash: this.#lastHash
    };
    const hash = hashAuditBase(base);
    const record: AuditRecord<TPayload> = { ...base, hash };
    await mkdir(dirname(this.#path), { recursive: true });
    await appendFile(this.#path, `${JSON.stringify(record)}\n`, "utf8");
    this.#sequence = record.sequence;
    this.#lastHash = record.hash;
    return record;
  }

  public async lastHash(): Promise<string> {
    await this.#ready;
    return this.#lastHash;
  }

  async #load(): Promise<void> {
    try {
      const content = await readFile(this.#path, "utf8");
      for (const line of content.split("\n")) {
        if (line.trim().length === 0) {
          continue;
        }
        const parsed = JSON.parse(line) as AuditRecord;
        this.#sequence = parsed.sequence;
        this.#lastHash = parsed.hash;
      }
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }
}

function hashAuditBase(value: Omit<AuditRecord, "hash">): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
