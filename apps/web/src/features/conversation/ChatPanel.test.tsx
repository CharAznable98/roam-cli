// @vitest-environment jsdom
import "../../test/setup.js";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  MessageAttachment,
  RunnerCapability,
  Session,
} from "@roamcli/shared/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "./ChatPanel";
import type { UiMessage } from "./model";

const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;

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

const imageCapability: RunnerCapability = {
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
};

describe("ChatPanel", () => {
  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:preview"),
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

  it("submits the composer with Command+Enter", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
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

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("run tests", []));
    expect(composer).toHaveValue("");
  });

  it("submits the composer with Ctrl+Enter", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<ChatPanel session={baseSession} messages={[]} onSend={onSend} />);

    const composer = screen.getByRole("textbox", { name: "Chat composer" });
    fireEvent.change(composer, { target: { value: "  run lint  " } });
    fireEvent.keyDown(composer, {
      key: "Enter",
      code: "Enter",
      ctrlKey: true,
    });

    await waitFor(() => expect(onSend).toHaveBeenCalledWith("run lint", []));
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

  it("sends selected images with the composed message", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <ChatPanel
        session={baseSession}
        messages={[]}
        onSend={onSend}
        imageCapability={imageCapability}
      />,
    );

    fireEvent.change(fileInput(container), {
      target: {
        files: [new File(["hello"], "screen.png", { type: "image/png" })],
      },
    });
    await screen.findByLabelText("Attached images");
    fireEvent.change(screen.getByLabelText("Chat composer"), {
      target: { value: "describe this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend).toHaveBeenCalledWith("describe this", [
      {
        name: "screen.png",
        mimeType: "image/png",
        size: 5,
        contentBase64: "aGVsbG8=",
      },
    ]);
    await waitFor(() =>
      expect(screen.getByLabelText("Chat composer")).toHaveValue(""),
    );
    expect(screen.queryByLabelText("Attached images")).not.toBeInTheDocument();
  });

  it("keeps the draft and previews when sending images fails", async () => {
    const onSend = vi
      .fn()
      .mockRejectedValue(new Error("Images are unavailable"));
    const { container } = render(
      <ChatPanel
        session={baseSession}
        messages={[]}
        onSend={onSend}
        imageCapability={imageCapability}
      />,
    );

    fireEvent.change(fileInput(container), {
      target: {
        files: [new File(["hello"], "screen.png", { type: "image/png" })],
      },
    });
    await screen.findByLabelText("Attached images");
    fireEvent.change(screen.getByLabelText("Chat composer"), {
      target: { value: "keep this draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Images are unavailable",
    );
    expect(screen.getByLabelText("Chat composer")).toHaveValue(
      "keep this draft",
    );
    expect(screen.getByLabelText("Attached images")).toBeInTheDocument();
  });

  it("renders a friendly placeholder when attachment content cannot be fetched", async () => {
    const attachment: MessageAttachment = {
      id: "attachment-1",
      sessionId: "session-1",
      messageId: "message-1",
      runnerId: "runner-1",
      kind: "image",
      name: "screen.png",
      mimeType: "image/png",
      size: 5,
      sha256: "0123456789abcdef0123456789abcdef",
      status: "available",
      createdAt: "2026-06-05T00:00:00.000Z",
    };
    const message: UiMessage = {
      id: "message-1",
      sessionId: "session-1",
      role: "user",
      content: "see image",
      encrypted: false,
      createdAt: "2026-06-05T00:00:00.000Z",
      attachments: [attachment],
    };
    const onFetchAttachmentContent = vi
      .fn()
      .mockRejectedValue(new Error("not found"));

    render(
      <ChatPanel
        session={baseSession}
        messages={[message]}
        onSend={vi.fn()}
        imageCapability={imageCapability}
        onFetchAttachmentContent={onFetchAttachmentContent}
      />,
    );

    await waitFor(() =>
      expect(onFetchAttachmentContent).toHaveBeenCalledWith(
        "session-1",
        "attachment-1",
      ),
    );
    expect(screen.getByText("Image unavailable")).toBeInTheDocument();
  });

  it("opens assistant markdown file links through the session file handler", () => {
    const onOpenFileLink = vi.fn();
    const message: UiMessage = {
      id: "message-1",
      sessionId: "session-1",
      role: "assistant",
      content: "Open [App](/workspace/src/App.tsx:12).",
      encrypted: false,
      createdAt: "2026-06-05T00:00:00.000Z",
    };

    render(
      <ChatPanel
        session={baseSession}
        messages={[message]}
        onSend={vi.fn()}
        onOpenFileLink={onOpenFileLink}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "App" }));

    expect(onOpenFileLink).toHaveBeenCalledWith({
      path: "src/App.tsx",
      line: 12,
    });
  });

  it("does not render unresolved runner-local file paths as browser links", () => {
    const message: UiMessage = {
      id: "message-1",
      sessionId: "session-1",
      role: "assistant",
      content:
        "Open [outside](/runner-only/src/App.tsx:12) or [external](https://example.test).",
      encrypted: false,
      createdAt: "2026-06-05T00:00:00.000Z",
    };

    render(
      <ChatPanel
        session={baseSession}
        messages={[message]}
        onSend={vi.fn()}
        onOpenFileLink={vi.fn()}
      />,
    );

    expect(screen.queryByRole("link", { name: "outside" })).toBeNull();
    expect(screen.getByText("outside")).toHaveClass("is-unresolved");
    expect(screen.getByRole("link", { name: "external" })).toHaveAttribute(
      "href",
      "https://example.test",
    );
  });

  it("keeps session actions reachable from the compact action menu", () => {
    const onControl = vi.fn();
    const onDelete = vi.fn();
    render(
      <ChatPanel
        session={baseSession}
        messages={[]}
        onSend={vi.fn()}
        onControl={onControl}
        onDelete={onDelete}
        onRename={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));

    const menu = screen.getByRole("menu", { name: "Session actions" });
    expect(
      within(menu).getByRole("menuitem", { name: "Rename session" }),
    ).toBeEnabled();
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Stop session" }),
    );

    expect(onControl).toHaveBeenCalledWith("stop");
    expect(screen.queryByRole("menu", { name: "Session actions" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(
      within(screen.getByRole("menu", { name: "Session actions" })).getByRole(
        "menuitem",
        { name: "Delete session" },
      ),
    );

    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("file input was not rendered");
  }
  return input;
}
