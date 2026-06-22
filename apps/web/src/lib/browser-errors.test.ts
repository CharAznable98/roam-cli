import { describe, expect, it } from "vitest";
import {
  isExpectedCancellation,
  isExpectedClipboardPermissionError,
} from "./browser-errors";

describe("isExpectedCancellation", () => {
  it("recognizes Monaco-style canceled promises without masking unrelated errors", () => {
    expect(isExpectedCancellation("Canceled")).toBe(true);
    expect(isExpectedCancellation("Canceled: Canceled")).toBe(true);
    expect(
      isExpectedCancellation("Uncaught (in promise) Canceled: Canceled"),
    ).toBe(true);
    expect(isExpectedCancellation(new Error("Canceled"))).toBe(true);
    expect(isExpectedCancellation({ name: "Canceled", message: "Canceled" }))
      .toBe(true);
    expect(isExpectedCancellation({ message: "Canceled" })).toBe(true);
    expect(isExpectedCancellation(new Error("Network failed"))).toBe(false);
    expect(isExpectedCancellation({ message: "Clipboard denied" })).toBe(false);
  });
});

describe("isExpectedClipboardPermissionError", () => {
  it("recognizes browser clipboard permission denials only", () => {
    expect(
      isExpectedClipboardPermissionError(
        new DOMException(
          "Failed to execute 'write' on 'Clipboard': Write permission denied.",
          "NotAllowedError",
        ),
      ),
    ).toBe(true);
    expect(
      isExpectedClipboardPermissionError(
        new DOMException("Clipboard write is blocked.", "SecurityError"),
      ),
    ).toBe(true);
    expect(isExpectedClipboardPermissionError(new Error("Network failed")))
      .toBe(false);
  });
});
