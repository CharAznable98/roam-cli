import { execFile } from "node:child_process";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  setPrivateDirectoryMode,
  setPrivateMode,
  syncDirectoryHandle,
} from "../platform/filesystem.js";
import { writeFileContent } from "../workspace/files.js";
import { expectPrivateMode } from "./platform.js";
import { sanitizeAgentEnvironment } from "../agents/permissions.js";

it.runIf(process.platform === "win32")(
  "preserves Windows agent runtime and proxy settings without leaking runner credentials",
  () => {
    const env = sanitizeAgentEnvironment("standard", {
      UserProfile: "C:\\Users\\test",
      SystemRoot: "C:\\Windows",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "localhost,127.0.0.1",
      ROAM_RUNNER_TOKEN: "private",
      ROAMCLI_AGENT_CODEX_COMMAND: "untrusted-override",
    });
    expect(env).toEqual({
      UserProfile: "C:\\Users\\test",
      SystemRoot: "C:\\Windows",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "localhost,127.0.0.1",
    });
  },
);

it.runIf(process.platform === "win32")(
  "replaces broad explicit Windows grants with private inherited ACLs",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "roam-windows-acl-"));
    const path = join(directory, "private.json");
    try {
      await writeFile(path, "private");
      await promisify(execFile)(
        "icacls.exe",
        [directory, "/grant", "*S-1-1-0:(OI)(CI)R", "/q"],
        { windowsHide: true },
      );
      await promisify(execFile)(
        "icacls.exe",
        [path, "/grant", "*S-1-1-0:R", "/q"],
        { windowsHide: true },
      );
      await setPrivateDirectoryMode(directory);
      const handle = await open(path, "r");
      try {
        await setPrivateMode(handle, path, 0o600);
      } finally {
        await handle.close();
      }
      await expectPrivateMode(directory, 0o700);
      await expectPrivateMode(path, 0o600);
      const parent = await open(directory, "r");
      try {
        await syncDirectoryHandle(parent);
      } finally {
        await parent.close();
      }
      expect(await readFile(path, "utf8")).toBe("private");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  15000,
);

it("truncates an existing file when saving shorter UTF-8 content", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "roam-save-truncate-"));
  try {
    await writeFile(join(workspace, "file.txt"), "long original content\n");
    await writeFileContent({
      workspace,
      sessionCwd: workspace,
      path: "file.txt",
      content: "短\n",
      requestId: "save",
      sessionId: "s1",
    });
    expect(await readFile(join(workspace, "file.txt"), "utf8")).toBe("短\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
