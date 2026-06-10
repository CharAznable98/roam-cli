import { hashPayload, verifyApprovalSignature } from "@roamcli/security";

export class ApprovalSignatureVerifier {
  constructor(private readonly secret: string | undefined) {}

  isApprovalSignatureValid(
    approvalId: string,
    approved: boolean,
    signedAt: string,
    signature: string,
  ): boolean {
    if (!this.secret) {
      return true;
    }
    return verifyApprovalSignature(
      this.secret,
      approvalId,
      approved,
      signedAt,
      signature,
    );
  }

  isPatchSignatureValid(
    sessionId: string,
    patch: string,
    signedAt: string,
    signature: string,
  ): boolean {
    return this.isApprovalSignatureValid(
      patchSignatureTarget(sessionId, patch),
      true,
      signedAt,
      signature,
    );
  }
}

export function patchSignatureTarget(sessionId: string, patch: string): string {
  return `patch:${sessionId}:${hashPayload(patch)}`;
}
