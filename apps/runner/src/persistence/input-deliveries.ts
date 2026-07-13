import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  readPrivateJsonFile,
  writePrivateJsonFile,
} from "./private-json-file.js";

export interface InputDeliveryRecord {
  deliveryId: string;
  sessionId: string;
  inputRequestId?: string;
  contentHash: string;
  ownership: "owned" | "not_owned";
}

interface InputDeliveryFile {
  version: 1;
  receipts: InputDeliveryRecord[];
}

const MAX_RECEIPTS = 1_024;

export class InputDeliveryStore {
  readonly #path: string;
  readonly #records = new Map<string, InputDeliveryRecord>();
  #loadPromise?: Promise<void>;
  #tail = Promise.resolve();

  public constructor(stateDir: string) {
    this.#path = join(stateDir, "input-delivery-receipts.json");
  }

  public async get(
    deliveryId: string,
  ): Promise<InputDeliveryRecord | undefined> {
    await this.#tail;
    await this.#load();
    return this.#records.get(deliveryId);
  }

  public async put(record: InputDeliveryRecord): Promise<void> {
    const operation = this.#tail.then(async () => {
      await this.#load();
      this.#records.delete(record.deliveryId);
      this.#records.set(record.deliveryId, record);
      while (this.#records.size > MAX_RECEIPTS) {
        const oldest = this.#records.keys().next().value as string | undefined;
        if (oldest === undefined) {
          break;
        }
        this.#records.delete(oldest);
      }
      await this.#write();
    });
    this.#tail = operation.catch(() => undefined);
    await operation;
  }

  async #load(): Promise<void> {
    if (this.#loadPromise === undefined) {
      this.#loadPromise = this.#readFile();
    }
    await this.#loadPromise;
  }

  async #readFile(): Promise<void> {
    const content = await readPrivateJsonFile(
      this.#path,
      "Input delivery receipt store",
    );
    if (content === undefined) {
      return;
    }
    try {
      const parsed = JSON.parse(content) as Partial<InputDeliveryFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.receipts)) {
        throw new Error("unsupported receipt document");
      }
      const validated = new Map<string, InputDeliveryRecord>();
      for (const candidate of parsed.receipts) {
        if (!isRecord(candidate)) {
          throw new Error("invalid receipt element");
        }
        const existing = validated.get(candidate.deliveryId);
        if (existing !== undefined && !isDeepStrictEqual(existing, candidate)) {
          throw new Error(
            `conflicting duplicate deliveryId: ${candidate.deliveryId}`,
          );
        }
        validated.delete(candidate.deliveryId);
        validated.set(candidate.deliveryId, candidate);
      }
      for (const candidate of [...validated.values()].slice(-MAX_RECEIPTS)) {
        this.#records.set(candidate.deliveryId, candidate);
      }
    } catch (error: unknown) {
      throw new Error(
        `Input delivery receipt store is corrupt; move or remove ${this.#path} before restarting the runner`,
        { cause: error },
      );
    }
  }

  async #write(): Promise<void> {
    await writePrivateJsonFile(
      this.#path,
      `${JSON.stringify({
        version: 1,
        receipts: [...this.#records.values()],
      } satisfies InputDeliveryFile)}\n`,
    );
  }
}

function isRecord(value: unknown): value is InputDeliveryRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<InputDeliveryRecord>;
  return (
    typeof record.deliveryId === "string" &&
    typeof record.sessionId === "string" &&
    (record.inputRequestId === undefined ||
      typeof record.inputRequestId === "string") &&
    typeof record.contentHash === "string" &&
    (record.ownership === "owned" || record.ownership === "not_owned")
  );
}
