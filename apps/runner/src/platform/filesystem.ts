import { execFile } from "node:child_process";
import { lstat, rename, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const protectedPaths = new Map<string, Promise<void>>();
const directoryAclScript = `
$ErrorActionPreference = 'Stop'
$item = Get-Item -LiteralPath $env:ROAMCLI_PRIVATE_PATH -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Private directory cannot be a reparse point' }
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetAccessRuleProtection($true, $false)
$sids = @([Security.Principal.WindowsIdentity]::GetCurrent().User, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
foreach ($sid in $sids) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
$item.SetAccessControl($acl)
`;

/** POSIX modes do not restrict Windows users. Secure state with a protected DACL. */
export async function setPrivateMode(
  handle: FileHandle,
  path: string,
  mode: 0o600 | 0o700,
): Promise<void> {
  if (process.platform !== "win32") {
    await handle.chmod(mode);
    return;
  }
  const opened = await handle.stat({ bigint: true });
  const current = await lstat(path, { bigint: true });
  if (
    current.isSymbolicLink() ||
    opened.dev !== current.dev ||
    opened.ino !== current.ino
  ) {
    throw new Error(`Private state path changed during operation: ${path}`);
  }
  await protectWindowsPath(path, mode === 0o700, `${opened.dev}:${opened.ino}`);
  const after = await lstat(path, { bigint: true });
  if (
    after.isSymbolicLink() ||
    opened.dev !== after.dev ||
    opened.ino !== after.ino
  ) {
    throw new Error(`Private state path changed during operation: ${path}`);
  }
}

export async function setPrivateDirectoryMode(path: string): Promise<void> {
  const { open } = await import("node:fs/promises");
  const handle = await open(path, "r");
  try {
    if (!(await handle.stat({ bigint: true })).isDirectory())
      throw new Error(`Not a private directory: ${path}`);
    await setPrivateMode(handle, path, 0o700);
  } finally {
    await handle.close();
  }
}

async function protectWindowsPath(
  path: string,
  directory: boolean,
  identity: string,
): Promise<void> {
  const key = `${resolve(path).toLowerCase()}:${identity}`;
  let pending = protectedPaths.get(key);
  if (!pending) {
    pending = (async () => {
      const system32 = join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
      );
      if (directory) {
        await execFileAsync(
          join(system32, "WindowsPowerShell/v1.0/powershell.exe"),
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(directoryAclScript, "utf16le").toString("base64"),
          ],
          {
            windowsHide: true,
            env: { ...process.env, ROAMCLI_PRIVATE_PATH: path },
          },
        );
      } else {
        // Reset explicit grants only after the parent has a private, inheritable DACL.
        await setPrivateDirectoryMode(dirname(path));
        await execFileAsync(
          join(system32, "icacls.exe"),
          [path, "/reset", "/q"],
          { windowsHide: true },
        );
      }
    })();
    protectedPaths.set(key, pending);
    if (protectedPaths.size > 2048)
      protectedPaths.delete(protectedPaths.keys().next().value!);
    pending.catch(() => protectedPaths.delete(key));
  }
  await pending;
}

/** Node cannot flush directory handles on Windows; file contents are still fsynced. */
export async function syncDirectoryHandle(handle: FileHandle): Promise<void> {
  if (process.platform !== "win32") await handle.sync();
}

/** Windows readers and antivirus scanners can briefly deny replacement of an open file. */
export async function renameWithRetry(
  source: string,
  target: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        attempt >= 10 ||
        !["EPERM", "EACCES", "EBUSY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, Math.min(20 * (attempt + 1), 100)),
      );
    }
  }
}
