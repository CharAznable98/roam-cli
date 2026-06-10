import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildArtifact, sha256File } from "../persistence/artifacts.js";

describe("artifacts", () => {
  it("computes sha256 metadata for emitted artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "roam-runner-artifact-"));
    const path = join(dir, "result.txt");
    await writeFile(path, "hello", "utf8");

    expect(await sha256File(path)).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    await expect(buildArtifact("s1", path, "file", "text/plain")).resolves.toMatchObject({
      sessionId: "s1",
      kind: "file",
      name: "result.txt",
      mimeType: "text/plain",
      size: 5,
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    });
  });
});
