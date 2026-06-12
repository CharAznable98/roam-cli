import { describe, expect, it } from "vitest";
import {
  createAuditRecord,
  decryptJson,
  deriveSharedSecret,
  encryptJson,
  generateX25519KeyPair,
  signApproval,
  verifyApprovalSignature,
  verifyAuditChain
} from "./index.js";

describe("security", () => {
  it("encrypts between x25519 peers", () => {
    const a = generateX25519KeyPair();
    const b = generateX25519KeyPair();
    const secretA = deriveSharedSecret(a.privateKey, b.publicKey);
    const secretB = deriveSharedSecret(b.privateKey, a.publicKey);
    const encrypted = encryptJson(secretA, { message: "hello" });
    expect(decryptJson<{ message: string }>(secretB, encrypted).message).toBe("hello");
  });

  it("signs approval decisions", () => {
    const signature = signApproval("secret", "approval-1", true, "2026-06-05T00:00:00.000Z");
    expect(verifyApprovalSignature("secret", "approval-1", true, "2026-06-05T00:00:00.000Z", signature)).toBe(true);
  });

  it("verifies append-only audit chains", () => {
    const first = createAuditRecord({
      id: "1",
      timestamp: "2026-06-05T00:00:00.000Z",
      actor: "client",
      action: "approve",
      target: "approval-1",
      payload: { approved: true }
    });
    const second = createAuditRecord({
      id: "2",
      timestamp: "2026-06-05T00:00:01.000Z",
      actor: "runner",
      action: "execute",
      target: "approval-1",
      payload: { command: "pnpm test" },
      previousHash: first.hash
    });
    expect(verifyAuditChain([first, second])).toBe(true);
  });
});
