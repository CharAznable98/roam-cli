import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import type { Artifact, ArtifactKind } from "@roamcli/protocol";
import { nowIso } from "@roamcli/protocol";

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

export async function buildArtifact(sessionId: string, path: string, kind: ArtifactKind, mimeType: string): Promise<Artifact> {
  const [fileStat, sha256] = await Promise.all([stat(path), sha256File(path)]);
  return {
    id: randomUUID(),
    sessionId,
    kind,
    name: basename(path),
    mimeType,
    size: fileStat.size,
    sha256,
    storagePath: path,
    createdAt: nowIso()
  };
}
