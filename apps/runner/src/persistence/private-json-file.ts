import {
  setPrivateMode,
  syncDirectoryHandle,
  renameWithRetry,
} from "../platform/filesystem.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export async function readPrivateJsonFile(
  path: string,
  label: string,
): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Error(`${label} is not a private regular file: ${path}`, {
      cause: error,
    });
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1) {
      throw new Error(`${label} is not a private regular file: ${path}`);
    }
    if ((info.mode & 0o777) !== 0o600) {
      await setPrivateMode(handle, path, 0o600);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function writePrivateJsonFile(
  path: string,
  content: string,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const securedDirectory = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | NO_FOLLOW,
  );
  try {
    const info = await securedDirectory.stat();
    if (!info.isDirectory()) {
      throw new Error(`Receipt directory is not a private directory`);
    }
    if ((info.mode & 0o777) !== 0o700) {
      await setPrivateMode(securedDirectory, directory, 0o700);
    }
  } finally {
    await securedDirectory.close();
  }
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1) {
        throw new Error(`Temporary receipt is not a private regular file`);
      }
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temporary, path);
    const directoryHandle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | NO_FOLLOW,
    );
    try {
      await syncDirectoryHandle(directoryHandle);
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
