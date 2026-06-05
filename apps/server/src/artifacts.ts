import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ArtifactKindSchema, nowIso, type Artifact } from "@roamcli/protocol";
import { newId } from "./ids.js";

export const CreateArtifactRequestSchema = z
  .object({
    sessionId: z.string().min(1),
    kind: ArtifactKindSchema,
    name: z.string().min(1),
    mimeType: z.string().min(1),
    contentBase64: z.string().min(1).optional(),
    content: z.string().optional()
  })
  .refine((value) => value.contentBase64 !== undefined || value.content !== undefined, {
    message: "contentBase64 or content is required"
  });

export type CreateArtifactRequest = z.infer<typeof CreateArtifactRequestSchema>;

export class ArtifactStorage {
  readonly rootDir: string;

  constructor(dataDir: string) {
    this.rootDir = path.join(dataDir, "artifacts");
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  write(request: CreateArtifactRequest): Artifact {
    const id = newId("artifact");
    const bytes = request.contentBase64 ? Buffer.from(request.contentBase64, "base64") : Buffer.from(request.content ?? "", "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const sessionDir = path.join(this.rootDir, sanitizePathSegment(request.sessionId));
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
      createdAt: nowIso()
    };
  }
}

function sanitizePathSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || "artifact";
}
