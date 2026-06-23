// @vitest-environment jsdom
import "../../test/setup.js";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { codeToHtml } from "shiki";
import type {
  AgentActivity,
  MessageAttachment,
  RunnerCapability,
  Session,
} from "@roamcli/shared/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "./ChatPanel";
import type { UiMessage } from "./model";

vi.mock("shiki", () => ({
  codeToHtml: vi.fn(async (code: string) => `<pre><code>${code}</code></pre>`),
}));

const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;
const originalInnerWidth = window.innerWidth;
const codeToHtmlMock = vi.mocked(codeToHtml);

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
    codeToHtmlMock.mockClear();
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
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: originalInnerWidth,
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

  it("uses a short composer placeholder on mobile widths", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 390,
    });

    render(<ChatPanel session={baseSession} messages={[]} onSend={vi.fn()} />);

    expect(
      screen.getByRole("textbox", { name: "Chat composer" }),
    ).toHaveAttribute("placeholder", "Message the active session");
  });

  it("disables follow-up sends while a Claude Code turn is active", () => {
    const onSend = vi.fn();
    render(
      <ChatPanel
        session={{ ...baseSession, agent: "claude-code", status: "running" }}
        messages={[]}
        onSend={onSend}
      />,
    );

    const composer = screen.getByRole("textbox", { name: "Chat composer" });
    expect(composer).toHaveAttribute("placeholder", "Waiting for Claude Code");
    fireEvent.change(composer, { target: { value: "follow up" } });

    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    fireEvent.keyDown(composer, {
      key: "Enter",
      code: "Enter",
      metaKey: true,
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows recovery guidance for failed sessions", () => {
    render(
      <ChatPanel
        session={{ ...baseSession, status: "failed" }}
        messages={[]}
        onSend={vi.fn()}
      />,
    );

    expect(screen.getByText("Session failed")).toBeInTheDocument();
    expect(screen.getByText(/Check status to refresh/)).toBeInTheDocument();
  });

  it("renders historical and latest activity groups without message bubbles", () => {
    const user: UiMessage = {
      id: "message-user",
      sessionId: "session-1",
      role: "user",
      content: "question",
      encrypted: false,
      createdAt: "2026-06-05T00:00:00.000Z",
    };
    const assistant: UiMessage = {
      ...user,
      id: "message-assistant",
      role: "assistant",
      content: "answer",
      createdAt: "2026-06-05T00:00:02.000Z",
    };
    const activities: AgentActivity[] = [
      {
        id: "activity-1",
        sessionId: "session-1",
        agent: "claude-code",
        kind: "task_progress",
        label: "Reading apps/web/src/app/useRoamController.ts",
        createdAt: "2026-06-05T00:00:01.000Z",
      },
      {
        id: "activity-2",
        sessionId: "session-1",
        agent: "claude-code",
        kind: "task_progress",
        label: "Running tests",
        createdAt: "2026-06-05T00:00:03.000Z",
      },
    ];

    render(
      <ChatPanel
        session={baseSession}
        messages={[user, assistant]}
        activities={activities}
        onSend={vi.fn()}
      />,
    );

    expect(screen.getByText("Activity (1)")).toBeInTheDocument();
    expect(screen.getByText("Running tests")).toBeInTheDocument();
    expect(screen.getByText("· 1 step")).toBeInTheDocument();
    expect(
      screen.queryByText("Reading apps/web/src/app/useRoamController.ts"),
    ).toBeNull();
    expect(screen.getAllByText("Running tests")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Activity (1)" }));
    expect(
      screen.getByText("Reading apps/web/src/app/useRoamController.ts"),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Running tests · 1 step" }),
    );
    expect(screen.getAllByText("Running tests")).toHaveLength(2);
    expect(screen.queryByText("Claude Code task progress:")).toBeNull();
  });

  it("collapses an expanded latest activity group when it becomes historical", async () => {
    const user: UiMessage = {
      id: "message-user",
      sessionId: "session-1",
      role: "user",
      content: "question",
      encrypted: false,
      createdAt: "2026-06-05T00:00:00.000Z",
    };
    const assistant: UiMessage = {
      ...user,
      id: "message-assistant",
      role: "assistant",
      content: "answer",
      createdAt: "2026-06-05T00:00:02.000Z",
    };
    const activities: AgentActivity[] = [
      {
        id: "activity-1",
        sessionId: "session-1",
        agent: "claude-code",
        kind: "task_progress",
        label: "Running tests",
        createdAt: "2026-06-05T00:00:01.000Z",
      },
    ];
    const onSend = vi.fn();
    const { rerender } = render(
      <ChatPanel
        session={{ ...baseSession, status: "running" }}
        messages={[user]}
        activities={activities}
        onSend={onSend}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Running tests · 1 step" }),
    );
    expect(screen.getAllByText("Running tests")).toHaveLength(2);

    rerender(
      <ChatPanel
        session={{ ...baseSession, status: "completed" }}
        messages={[user, assistant]}
        activities={activities}
        onSend={onSend}
      />,
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Activity (1)" }),
      ).toHaveAttribute("aria-expanded", "false"),
    );
    expect(screen.queryByText("Running tests")).toBeNull();
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

  it("keeps rendered assistant code blocks stable while composing drafts", async () => {
    const message: UiMessage = {
      id: "message-1",
      sessionId: "session-1",
      role: "assistant",
      content: "```ts\nconst value = 1;\n```",
      encrypted: false,
      createdAt: "2026-06-05T00:00:00.000Z",
    };

    render(
      <ChatPanel session={baseSession} messages={[message]} onSend={vi.fn()} />,
    );

    await waitFor(() => expect(codeToHtmlMock).toHaveBeenCalled());
    const highlightCount = codeToHtmlMock.mock.calls.length;

    const composer = screen.getByRole("textbox", { name: "Chat composer" });
    fireEvent.change(composer, { target: { value: "first draft" } });
    fireEvent.change(composer, { target: { value: "first draft update" } });

    expect(composer).toHaveValue("first draft update");
    expect(codeToHtmlMock).toHaveBeenCalledTimes(highlightCount);
  });

  it("groups session header actions in a text menu", () => {
    const onControl = vi.fn();
    const onRename = vi.fn();
    const onDelete = vi.fn();
    const onCheckStatus = vi.fn();
    render(
      <ChatPanel
        session={baseSession}
        messages={[]}
        onSend={vi.fn()}
        onControl={onControl}
        onRename={onRename}
        onDelete={onDelete}
        onCheckStatus={onCheckStatus}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Rename session" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    const menu = screen.getByRole("menu", { name: "Session actions" });

    expect(
      within(menu).getByRole("menuitem", { name: /Skill list/ }),
    ).toHaveTextContent(/^Skill list$/);
    expect(
      within(menu).getByRole("menuitem", { name: /Rename/ }),
    ).toHaveTextContent(/^Rename$/);
    expect(
      within(menu).getByRole("menuitem", { name: /Check status/ }),
    ).toHaveTextContent(/^Check status$/);
    expect(
      within(menu).getByRole("menuitem", { name: /Resume/ }),
    ).toHaveTextContent(/^Resume$/);
    expect(
      within(menu).getByRole("menuitem", { name: /Stop/ }),
    ).toHaveTextContent(/^Stop$/);
    expect(
      within(menu).getByRole("menuitem", { name: /Resume/ }),
    ).toBeDisabled();
    expect(
      within(menu).getByRole("menuitem", { name: /Stop/ }),
    ).not.toBeDisabled();
    expect(
      within(menu).getByRole("menuitem", { name: /Archive/ }),
    ).toHaveTextContent(/^Archive$/);
    expect(screen.queryByText("Edit session title")).not.toBeInTheDocument();
    expect(screen.queryByText("Refresh this session")).not.toBeInTheDocument();
    expect(screen.queryByText("Continue agent work")).not.toBeInTheDocument();
    expect(screen.queryByText("End current run")).not.toBeInTheDocument();
    expect(screen.queryByText("Remove this session")).not.toBeInTheDocument();

    fireEvent.click(within(menu).getByRole("menuitem", { name: /Stop/ }));

    expect(onControl).toHaveBeenCalledWith("stop");
    expect(
      screen.queryByRole("menu", { name: "Session actions" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(
      within(screen.getByRole("menu", { name: "Session actions" })).getByRole(
        "menuitem",
        { name: /Check status/ },
      ),
    );

    expect(onCheckStatus).toHaveBeenCalledTimes(1);
  });

  it("opens a read-only skill list from the session menu", async () => {
    const onListAgentSkills = vi.fn(async () => ({
      requestId: "skills-1",
      agent: "codex",
      basePath: "/workspace",
      queriedAt: "2026-06-20T00:00:00.000Z",
      skills: [
        {
          name: "plan",
          description: "Plan work",
          sourceType: "project" as const,
          sourcePath: "/workspace/.codex/skills/plan",
        },
      ],
    }));
    render(
      <ChatPanel
        session={baseSession}
        messages={[]}
        onSend={vi.fn()}
        onListAgentSkills={onListAgentSkills}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    fireEvent.click(
      within(screen.getByRole("menu", { name: "Session actions" })).getByRole(
        "menuitem",
        { name: /Skill list/ },
      ),
    );

    expect(
      await screen.findByRole("dialog", { name: "Skill list" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("$plan")).toBeInTheDocument();
    expect(screen.getByText("Plan work")).toBeInTheDocument();
    expect(onListAgentSkills).toHaveBeenCalledWith({
      runnerId: "runner-1",
      agent: "codex",
      basePath: "/workspace",
    });
  });

  it("disables stop for inactive sessions while keeping resume available", () => {
    render(
      <ChatPanel
        session={{ ...baseSession, status: "stopped" }}
        messages={[]}
        onSend={vi.fn()}
        onControl={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onCheckStatus={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    const menu = screen.getByRole("menu", { name: "Session actions" });

    expect(
      within(menu).getByRole("menuitem", { name: /Resume/ }),
    ).not.toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: /Stop/ })).toBeDisabled();
  });

  it("disables runner control actions when the selected runner is offline", () => {
    render(
      <ChatPanel
        session={baseSession}
        messages={[]}
        onSend={vi.fn()}
        onControl={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        onCheckStatus={vi.fn()}
        canControl={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    const menu = screen.getByRole("menu", { name: "Session actions" });

    expect(
      within(menu).getByRole("menuitem", { name: /Check status/ }),
    ).not.toBeDisabled();
    expect(
      within(menu).getByRole("menuitem", { name: /Resume/ }),
    ).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: /Stop/ })).toBeDisabled();
  });
});

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("file input was not rendered");
  }
  return input;
}
