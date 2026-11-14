import { execFile } from "node:child_process";
import { stat, symlink as nativeSymlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { beforeEach, expect, type TestContext } from "vitest";

let context: TestContext;
beforeEach((value) => {
  context = value;
});

export async function symlink(
  target: string,
  path: string,
  type?: "dir" | "file" | "junction",
): Promise<void> {
  const absolute = resolve(dirname(path), target);
  const directory =
    type === "dir" ||
    type === "junction" ||
    (type === undefined &&
      (await stat(absolute)
        .then((s) => s.isDirectory())
        .catch(() => false)));
  try {
    await nativeSymlink(
      process.platform === "win32" && directory ? absolute : target,
      path,
      process.platform === "win32" && directory ? "junction" : type,
    );
  } catch (error) {
    if (
      process.platform === "win32" &&
      (error as NodeJS.ErrnoException).code === "EPERM"
    ) {
      context.skip(
        "File symlinks require Windows Developer Mode or the symlink privilege",
      );
    }
    throw error;
  }
}

export async function expectPrivateMode(
  path: string,
  mode: number,
): Promise<void> {
  if (process.platform !== "win32") {
    expect((await stat(path)).mode & 0o777).toBe(mode);
    return;
  }
  const script = `
$ErrorActionPreference = 'Stop'
$acl = if ([IO.Directory]::Exists($env:ROAMCLI_TEST_ACL_PATH)) { [IO.Directory]::GetAccessControl($env:ROAMCLI_TEST_ACL_PATH) } else { [IO.File]::GetAccessControl($env:ROAMCLI_TEST_ACL_PATH) }
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { @{sid=$_.IdentityReference.Value;rights=[int]$_.FileSystemRights;type=[int]$_.AccessControlType} })
@{current=$current;rules=$rules} | ConvertTo-Json -Compress -Depth 4
`;
  const { stdout } = await promisify(execFile)(
    join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { windowsHide: true, env: { ...process.env, ROAMCLI_TEST_ACL_PATH: path } },
  );
  const acl = JSON.parse(stdout);
  expect(acl.rules.length).toBeGreaterThan(0);
  for (const rule of acl.rules) {
    expect([acl.current, "S-1-5-18", "S-1-5-32-544"]).toContain(rule.sid);
    expect(rule.type).toBe(0);
  }
  expect(
    acl.rules.some(
      (rule: { sid: string; rights: number }) =>
        rule.sid === acl.current && (rule.rights & 2032127) === 2032127,
    ),
  ).toBe(true);
}
