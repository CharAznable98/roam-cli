// @vitest-environment jsdom
import "../../test/setup.js";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Session } from "@roamcli/shared/protocol";
import { ChatPanel } from "./ChatPanel";

const baseSession: Session = {
  id: "session-1",
  title: "Active session",
  projectId: "project-1",
  runnerId: "runner-1",
  agent: "codex",
  status: "running",
  executionMode: "direct",
  executionFolder: "/workspace",
  cwd: "/workspace",
  createdAt: "2026-06-05T00:00:00.000Z",
  updatedAt: "2026-06-05T00:00:00.000Z",
};

describe("ChatPanel", () => {
  it("submits the composer with Command+Enter", () => {
    const onSend = vi.fn();
    render(<ChatPanel session={baseSession} messages={[]} onSend={onSend} />);

    const composer = screen.getByRole("textbox", { name: "Chat composer" });
    expect(composer).toHaveAttribute(
      "placeholder",
      "Message the active session, Cmd/Ctrl+Enter to send",
    );
    fireEvent.change(composer, { target: { value: "  run tests  " } });
    fireEvent.keyDown(composer, {
      key: "Enter",
      code: "Enter",
      metaKey: true,
    });

    expect(onSend).toHaveBeenCalledWith("run tests");
    expect(composer).toHaveValue("");
  });

  it("submits the composer with Ctrl+Enter", () => {
    const onSend = vi.fn();
    render(<ChatPanel session={baseSession} messages={[]} onSend={onSend} />);

    const composer = screen.getByRole("textbox", { name: "Chat composer" });
    fireEvent.change(composer, { target: { value: "  run lint  " } });
    fireEvent.keyDown(composer, {
      key: "Enter",
      code: "Enter",
      ctrlKey: true,
    });

    expect(onSend).toHaveBeenCalledWith("run lint");
    expect(composer).toHaveValue("");
  });

  it("does not submit while IME composition is active", () => {
    const onSend = vi.fn();
    render(<ChatPanel session={baseSession} messages={[]} onSend={onSend} />);

    const composer = screen.getByRole("textbox", { name: "Chat composer" });
    fireEvent.change(composer, { target: { value: "中文输入" } });
    fireEvent.keyDown(composer, {
      key: "Enter",
      code: "Enter",
      metaKey: true,
      isComposing: true,
    });

    expect(onSend).not.toHaveBeenCalled();
    expect(composer).toHaveValue("中文输入");
  });

  it("keeps plain Enter available for multiline drafts", () => {
    const onSend = vi.fn();
    render(<ChatPanel session={baseSession} messages={[]} onSend={onSend} />);

    const composer = screen.getByRole("textbox", { name: "Chat composer" });
    fireEvent.change(composer, { target: { value: "first line" } });
    fireEvent.keyDown(composer, {
      key: "Enter",
      code: "Enter",
    });

    expect(onSend).not.toHaveBeenCalled();
    expect(composer).toHaveValue("first line");
  });
});
