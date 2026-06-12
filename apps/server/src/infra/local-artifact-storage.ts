import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ArtifactKindSchema, nowIso, type Artifact } from "@roamcli/shared/protocol";
import { newId } from "./ids.js";

export const CreateArtifactRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    kind: ArtifactKindSchema,
    name: z.string().min(1),
    mimeType: z.string().min(1),
    contentBase64: z
      .string()
      .min(1)
      .refine(isValidBase64, {
        message: "contentBase64 must be valid base64",
      })
      .optional(),
    content: z.string().optional(),
  })
  .refine(
    (value) => value.contentBase64 !== undefined || value.content !== undefined,
    {
      message: "contentBase64 or content is required",
    },
  );

export type CreateArtifactRequest = z.infer<typeof CreateArtifactRequestSchema>;

export class ArtifactStorage {
  readonly rootDir: string;

  constructor(dataDir: string) {
    this.rootDir = path.join(dataDir, "artifacts");
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  write(request: CreateArtifactRequest): Artifact {
    const id = newId("artifact");
    const bytes = request.contentBase64
      ? Buffer.from(request.contentBase64, "base64")
      : Buffer.from(request.content ?? "", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const sessionDir = path.join(
      this.rootDir,
      sanitizePathSegment(request.sessionId),
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    const fileName = `${id}-${sanitizePathSegment(request.name)}`;
    const storagePath = path.join(sessionDir, fileName);
    fs.writeFileSync(storagePath, bytes);

    return {
      id,
      sessionId: request.sessionId,
      kind: request.kind,
      name: request.name,
      mimeType: request.mimeType,
      size: bytes.byteLength,
      sha256,
      storagePath,
      createdAt: nowIso(),
    };
  }

  deleteArtifact(artifact: Artifact): void {
    const storagePath = path.resolve(artifact.storagePath);
    const rootDir = path.resolve(this.rootDir);
    if (
      storagePath === rootDir ||
      !storagePath.startsWith(`${rootDir}${path.sep}`)
    ) {
      return;
    }
    fs.rmSync(storagePath, { force: true });
  }

  deleteSessionArtifacts(sessionId: string): void {
    fs.rmSync(path.join(this.rootDir, sanitizePathSegment(sessionId)), {
      recursive: true,
      force: true,
    });
  }
}

function sanitizePathSegment(segment: string): string {
  const safe = segment.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 180);
  return safe.replace(/^_+$/g, "") || "artifact";
}

function isValidBase64(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return false;
  }
  if (value.includes("=") && !/^[A-Za-z0-9+/]+={1,2}$/.test(value)) {
    return false;
  }
  if (value.length % 4 === 1) {
    return false;
  }
  try {
    const unpadded = value.replace(/=+$/, "");
    const padded = unpadded.padEnd(Math.ceil(unpadded.length / 4) * 4, "=");
    return (
      Buffer.from(padded, "base64").toString("base64").replace(/=+$/, "") ===
      unpadded
    );
  } catch {
    return false;
  }
}
