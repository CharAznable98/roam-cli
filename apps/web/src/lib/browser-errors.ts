export function installExpectedBrowserErrorHandlers(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.addEventListener("unhandledrejection", (event) => {
    if (isExpectedCancellation(event.reason)) {
      event.preventDefault();
    }
  });
  window.addEventListener("error", (event) => {
    if (
      isExpectedCancellation(event.error) ||
      isExpectedCancellation(event.message)
    ) {
      event.preventDefault();
    }
  });
  installClipboardPermissionGuard();
}

export function isExpectedCancellation(reason: unknown): boolean {
  if (typeof reason === "string") {
    return isExpectedCancellationText(reason);
  }
  if (reason instanceof Error) {
    return (
      isExpectedCancellationText(reason.message) ||
      isExpectedCancellationText(reason.name)
    );
  }
  if (reason && typeof reason === "object" && "message" in reason) {
    const message = (reason as { message?: unknown }).message;
    const name = (reason as { name?: unknown }).name;
    return (
      (typeof message === "string" &&
        isExpectedCancellationText(message)) ||
      (typeof name === "string" && isExpectedCancellationText(name))
    );
  }
  return false;
}

export function isExpectedClipboardPermissionError(error: unknown): boolean {
  const name =
    error && typeof error === "object" && "name" in error
      ? String((error as { name?: unknown }).name ?? "")
      : "";
  const message =
    error && typeof error === "object" && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error ?? "");
  return (
    (name === "NotAllowedError" || name === "SecurityError") &&
    /clipboard|permission|denied/i.test(message)
  );
}

function isExpectedCancellationText(value: string): boolean {
  const text = value.trim();
  return (
    text === "Canceled" ||
    text === "Canceled: Canceled" ||
    text === "Uncaught (in promise) Canceled" ||
    text === "Uncaught (in promise) Canceled: Canceled"
  );
}

function installClipboardPermissionGuard(): void {
  const clipboard = navigator.clipboard;
  const write = clipboard?.write;
  if (typeof write !== "function" || isPatchedClipboardWrite(write)) {
    return;
  }
  const guardedWrite: Clipboard["write"] = async function guardedWrite(data) {
    try {
      await write.call(clipboard, data);
    } catch (error: unknown) {
      if (isExpectedClipboardPermissionError(error)) {
        return;
      }
      throw error;
    }
  };
  Object.defineProperty(guardedWrite, patchedClipboardWrite, {
    value: true,
  });
  try {
    Object.defineProperty(clipboard, "write", {
      configurable: true,
      value: guardedWrite,
    });
  } catch {
    clipboard.write = guardedWrite;
  }
}

const patchedClipboardWrite = Symbol("roamcli.patchedClipboardWrite");

function isPatchedClipboardWrite(
  write: Clipboard["write"],
): write is Clipboard["write"] & { [patchedClipboardWrite]: true } {
  return Boolean(
    (write as Clipboard["write"] & { [patchedClipboardWrite]?: true })[
      patchedClipboardWrite
    ],
  );
}
