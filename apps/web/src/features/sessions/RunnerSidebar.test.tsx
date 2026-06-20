// @vitest-environment jsdom
import "../../test/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  type RunnerRegistration,
} from "@roamcli/shared/protocol";
import { describe, expect, it, vi } from "vitest";
import { ProjectForm } from "./RunnerSidebar";

describe("ProjectForm", () => {
  it("keeps the runner base read-only and resets the suffix when runner changes", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<ProjectForm runners={runners} onCreate={onCreate} />);

    expect(screen.getByLabelText("Runner base")).toHaveValue("/workspace");
    expect(screen.getByLabelText("Runner base")).toHaveAttribute("readonly");

    fireEvent.change(screen.getByLabelText("Directory"), {
      target: { value: "mobile" },
    });
    fireEvent.change(screen.getByLabelText("Runner"), {
      target: { value: "runner-2" },
    });

    expect(screen.getByLabelText("Runner base")).toHaveValue("/backup");
    expect(screen.getByLabelText("Directory")).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "Create project" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith({
        name: "backup",
        runnerId: "runner-2",
        directory: "/backup",
      });
    });
  });
});

const runners: RunnerRegistration[] = [
  {
    runnerId: "runner-1",
    displayName: "Runner One",
    hostname: "devbox.local",
    workspaceRoot: "/workspace",
    profile: "trusted",
    publicKey: "0123456789abcdef",
    capabilities: [
      {
        kind: "codex",
        label: "Codex",
        command: "codex",
        args: [],
        parser: "codex-json",
        supportsResume: true,
        supportsImages: false,
        supportedImageMimeTypes: [],
        maxImagesPerTurn: 0,
        maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
      },
    ],
    version: "1.1.0",
  },
  {
    runnerId: "runner-2",
    displayName: "Runner Two",
    hostname: "backup.local",
    workspaceRoot: "/backup",
    profile: "trusted",
    publicKey: "abcdef0123456789",
    capabilities: [
      {
        kind: "codex",
        label: "Codex",
        command: "codex",
        args: [],
        parser: "codex-json",
        supportsResume: true,
        supportsImages: false,
        supportedImageMimeTypes: [],
        maxImagesPerTurn: 0,
        maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
      },
    ],
    version: "1.1.0",
  },
];
