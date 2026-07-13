import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  RunnerCommandSchema,
  type RunnerAttachmentRef,
  type Session,
} from "@roamcli/shared/protocol";
import {
  readPrivateJsonFile,
  writePrivateJsonFile,
} from "./private-json-file.js";

export interface StartDeliveryPayload {
  requestId: string;
  session: Session;
  prompt: string;
  resumeThreadId?: string;
  attachments: RunnerAttachmentRef[];
}

export interface StartDeliveryRecord {
  deliveryId: string;
  payloadHash: string;
  payload: StartDeliveryPayload;
  state: "accepted" | "launching" | "launched" | "completed" | "not_owned";
  bootId?: string;
}

interface StartDeliveryFile {
  version: 1;
  receipts: StartDeliveryRecord[];
}

const MAX_RECEIPTS = 1_024;

export class StartDeliveryStore {
  readonly #path: string;
  readonly #records = new Map<string, StartDeliveryRecord>();
  #loadPromise?: Promise<void>;
  #tail = Promise.resolve();

  public constructor(stateDir: string) {
    this.#path = join(stateDir, "start-delivery-receipts.json");
  }

  public async get(
    deliveryId: string,
  ): Promise<StartDeliveryRecord | undefined> {
    await this.#tail;
    await this.#load();
    return this.#records.get(deliveryId);
  }

  public async put(record: StartDeliveryRecord): Promise<void> {
    const operation = this.#tail.then(async () => {
      await this.#load();
      this.#records.delete(record.deliveryId);
      this.#records.set(record.deliveryId, record);
      this.#trimTerminalRecords();
      await this.#write();
    });
    this.#tail = operation.catch(() => undefined);
    await operation;
  }

  #trimTerminalRecords(): void {
    if (this.#records.size <= MAX_RECEIPTS) {
      return;
    }
    for (const [deliveryId, record] of this.#records) {
      if (
        record.state === "accepted" ||
        record.state === "launching" ||
        record.state === "launched"
      ) {
        continue;
      }
      this.#records.delete(deliveryId);
      if (this.#records.size <= MAX_RECEIPTS) {
        return;
      }
    }
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
      "Start delivery receipt store",
    );
    if (content === undefined) {
      return;
    }
    try {
      const parsed = JSON.parse(content) as Partial<StartDeliveryFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.receipts)) {
        throw new Error("unsupported receipt document");
      }
      for (const candidate of parsed.receipts) {
        if (!isRecord(candidate)) {
          throw new Error("invalid receipt element");
        }
        const existing = this.#records.get(candidate.deliveryId);
        if (existing !== undefined && !isDeepStrictEqual(existing, candidate)) {
          throw new Error(
            `conflicting duplicate deliveryId: ${candidate.deliveryId}`,
          );
        }
        this.#records.set(candidate.deliveryId, candidate);
      }
      this.#trimTerminalRecords();
    } catch (error: unknown) {
      throw new Error(
        `Start delivery receipt store is corrupt; move or remove ${this.#path} before restarting the runner`,
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
      } satisfies StartDeliveryFile)}\n`,
    );
  }
}

function isRecord(value: unknown): value is StartDeliveryRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<StartDeliveryRecord>;
  return (
    typeof record.deliveryId === "string" &&
    typeof record.payloadHash === "string" &&
    (record.state === "accepted" ||
      record.state === "launching" ||
      record.state === "launched" ||
      record.state === "completed" ||
      record.state === "not_owned") &&
    (record.bootId === undefined || typeof record.bootId === "string") &&
    isPayload(record.payload)
  );
}

function isPayload(value: unknown): value is StartDeliveryPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const payload = value as Partial<StartDeliveryPayload>;
  if (
    typeof payload.requestId !== "string" ||
    payload.requestId.length === 0 ||
    payload.session === undefined ||
    typeof payload.prompt !== "string" ||
    !Array.isArray(payload.attachments)
  ) {
    return false;
  }
  return RunnerCommandSchema.safeParse({
    type: "startSession",
    requestId: payload.requestId,
    deliveryId: "receipt-validation",
    session: payload.session,
    prompt: payload.prompt,
    ...(payload.resumeThreadId === undefined
      ? {}
      : { resumeThreadId: payload.resumeThreadId }),
    attachments: payload.attachments,
  }).success;
}
