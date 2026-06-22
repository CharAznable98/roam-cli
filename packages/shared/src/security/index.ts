import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

export interface KeyPairPem {
  publicKey: string;
  privateKey: string;
}

export interface EncryptedPayload {
  alg: "X25519+A256GCM";
  kid: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface AuditRecord {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  target: string;
  payloadHash: string;
  previousHash: string;
  hash: string;
}

export function generateX25519KeyPair(): KeyPairPem {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function deriveSharedSecret(
  privateKeyPem: string,
  publicKeyPem: string,
): Buffer {
  return createHash("sha256")
    .update(
      diffieHellman({
        privateKey: createPrivateKey(privateKeyPem),
        publicKey: createPublicKey(publicKeyPem),
      }),
    )
    .digest();
}

export function encryptJson(
  secret: Buffer,
  value: unknown,
  kid = "session",
): EncryptedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", normalizeKey(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return {
    alg: "X25519+A256GCM",
    kid,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

export function decryptJson<T>(secret: Buffer, payload: EncryptedPayload): T {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    normalizeKey(secret),
    Buffer.from(payload.iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64url"));
  const cleartext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(cleartext) as T;
}

export function hashPayload(value: unknown): string {
  const normalized =
    typeof value === "string" || Buffer.isBuffer(value)
      ? value
      : stableStringify(value);
  return createHash("sha256").update(normalized).digest("hex");
}

export function createAuditRecord(input: {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  target: string;
  payload: unknown;
  previousHash?: string;
}): AuditRecord {
  const payloadHash = hashPayload(input.payload);
  const previousHash = input.previousHash ?? "GENESIS";
  const unsigned = {
    id: input.id,
    timestamp: input.timestamp,
    actor: input.actor,
    action: input.action,
    target: input.target,
    payloadHash,
    previousHash,
  };
  return {
    ...unsigned,
    hash: hashPayload(unsigned),
  };
}

export function verifyAuditChain(records: AuditRecord[]): boolean {
  let previousHash = "GENESIS";
  for (const record of records) {
    if (record.previousHash !== previousHash) return false;
    const { hash, ...unsigned } = record;
    if (hashPayload(unsigned) !== hash) return false;
    previousHash = hash;
  }
  return true;
}

export function publicKeyFingerprint(publicKeyPem: string): string {
  return createHash("sha256")
    .update(publicKeyPem)
    .digest("base64url")
    .slice(0, 32);
}

function normalizeKey(secret: Buffer): Buffer {
  return secret.length === 32
    ? secret
    : createHash("sha256").update(secret).digest();
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`)
    .join(",")}}`;
}

export type { KeyObject };
