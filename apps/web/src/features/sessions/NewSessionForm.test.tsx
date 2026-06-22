// @vitest-environment jsdom
import "../../test/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Project, RunnerRegistration } from "@roamcli/shared/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewSessionForm } from "./NewSessionForm";

const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

const project: Project = {
  id: "project-1",
  name: "Project",
  runnerId: "runner-1",
  directory: "/workspace",
  createdAt: "2026-06-05T00:00:00.000Z",
  updatedAt: "2026-06-05T00:00:00.000Z",
  lastActiveAt: "2026-06-05T00:00:00.000Z",
};

const runner: RunnerRegistration = {
  runnerId: "runner-1",
  displayName: "Runner",
  hostname: "localhost",
  workspaceRoot: "/workspace",
  profile: "trusted",
  publicKey: "0123456789abcdef",
  version: "1.0.0",
  capabilities: [
    {
      kind: "codex",
      label: "Codex",
      command: "codex",
      args: [],
      parser: "codex-json",
      supportsResume: true,
      supportsImages: true,
      supportedImageMimeTypes: ["image/png"],
      maxImagesPerTurn: 2,
      maxImageBytes: 1024,
    },
    {
      kind: "claude-code",
      label: "Claude Code",
      command: "claude",
      args: [],
      parser: "claude-agent-sdk",
      supportsResume: true,
      supportsImages: true,
      supportedImageMimeTypes: ["image/png", "image/jpeg", "image/webp"],
      maxImagesPerTurn: 4,
      maxImageBytes: 2048,
    },
  ],
};

describe("NewSessionForm image attachments", () => {
  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:new-session-preview"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreateObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: originalRevokeObjectUrl,
    });
  });

  it("creates the first session message with selected image uploads", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <NewSessionForm project={project} runner={runner} onCreate={onCreate} />,
    );

    fireEvent.change(fileInput(container), {
      target: {
        files: [new File(["hello"], "screen.png", { type: "image/png" })],
      },
    });
    await screen.findByLabelText("Attached images");
    fireEvent.change(screen.getByPlaceholderText("Describe the work"), {
      target: { value: "describe this image" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create session/ }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "describe this image",
        prompt: "describe this image",
        agent: "codex",
        executionMode: "managed_worktree",
        attachments: [
          {
            name: "screen.png",
            mimeType: "image/png",
            size: 5,
            contentBase64: "aGVsbG8=",
          },
        ],
      }),
    );
  });

  it("clears stale image validation errors when switching to an agent that supports the image type", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <NewSessionForm project={project} runner={runner} onCreate={onCreate} />,
    );

    fireEvent.change(fileInput(container), {
      target: {
        files: [new File(["hello"], "screen.webp", { type: "image/webp" })],
      },
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "image/webp is not supported.",
    );
    fireEvent.change(screen.getByLabelText("Agent"), {
      target: { value: "claude-code" },
    });

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("removes draft images that the newly selected agent does not support", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <NewSessionForm project={project} runner={runner} onCreate={onCreate} />,
    );

    fireEvent.change(screen.getByLabelText("Agent"), {
      target: { value: "claude-code" },
    });
    fireEvent.change(fileInput(container), {
      target: {
        files: [new File(["hello"], "screen.webp", { type: "image/webp" })],
      },
    });
    await screen.findByLabelText("Attached images");

    fireEvent.change(screen.getByLabelText("Agent"), {
      target: { value: "codex" },
    });

    await waitFor(() =>
      expect(screen.queryByLabelText("Attached images")).toBeNull(),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "image/webp is not supported.",
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(
      "blob:new-session-preview",
    );
  });
});

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("file input was not rendered");
  }
  return input;
}
