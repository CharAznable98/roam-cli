// @vitest-environment jsdom
import "../../test/setup.js";
import {
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  AgentSkillListResult,
  PathSearchResult,
  ProjectPromptPreset,
} from "@roamcli/shared/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type ComponentProps } from "react";
import { PromptComposer } from "./PromptComposer";
import { clearPromptResourceCaches } from "./prompt-resources";

describe("PromptComposer", () => {
  afterEach(() => {
    clearPromptResourceCaches();
  });

  it("loads skills after typing $ and inserts the selected skill", async () => {
    const listAgentSkills = vi.fn(
      async (): Promise<AgentSkillListResult> => ({
        requestId: "skills-1",
        agent: "codex",
        basePath: "/workspace",
        queriedAt: "2026-06-20T00:00:00.000Z",
        skills: [
          {
            name: "plan",
            description: "Plan work",
            sourceType: "project",
            sourcePath: "/workspace/.codex/skills/plan",
          },
        ],
      }),
    );
    const searchWorkspacePaths = vi.fn(
      async (): Promise<PathSearchResult> => ({
        requestId: "paths-1",
        basePath: "/workspace",
        query: "",
        entries: [],
      }),
    );

    render(
      <ComposerHarness
        onListAgentSkills={listAgentSkills}
        onSearchWorkspacePaths={searchWorkspacePaths}
      />,
    );

    const composer = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.change(composer, { target: { value: "Use $pla" } });

    await screen.findByText("$plan");
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });

    await waitFor(() => expect(composer).toHaveValue("Use $plan"));
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
    expect(listAgentSkills).toHaveBeenCalledTimes(1);
  });

  it("loads slash commands after typing / and inserts slash syntax", async () => {
    const listAgentSkills = vi.fn(
      async (): Promise<AgentSkillListResult> => ({
        requestId: "skills-1",
        agent: "claude-code",
        basePath: "/workspace",
        queriedAt: "2026-06-20T00:00:00.000Z",
        skills: [
          {
            name: "plan",
            description: "Plan work",
            sourceType: "project",
            sourcePath: "/workspace/.codex/skills/plan",
          },
          {
            name: "compact",
            description: "Compact context",
            insertText: "/compact",
            sourceType: "project",
            sourcePath: "/workspace",
          },
        ],
      }),
    );
    const searchWorkspacePaths = vi.fn(
      async (): Promise<PathSearchResult> => ({
        requestId: "paths-1",
        basePath: "/workspace",
        query: "",
        entries: [],
      }),
    );

    render(
      <ComposerHarness
        agent="claude-code"
        onListAgentSkills={listAgentSkills}
        onSearchWorkspacePaths={searchWorkspacePaths}
      />,
    );

    const composer = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.change(composer, { target: { value: "Run /co" } });

    await screen.findByText("/compact");
    expect(screen.queryByText("$plan")).not.toBeInTheDocument();
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });

    await waitFor(() => expect(composer).toHaveValue("Run /compact"));
    expect(listAgentSkills).toHaveBeenCalledWith({
      runnerId: "runner-1",
      agent: "claude-code",
      basePath: "/workspace",
    });
  });

  it("searches top-level paths for an empty @ query and quotes paths with spaces", async () => {
    const listAgentSkills = vi.fn(
      async (): Promise<AgentSkillListResult> => ({
        requestId: "skills-1",
        agent: "codex",
        basePath: "/workspace",
        queriedAt: "2026-06-20T00:00:00.000Z",
        skills: [],
      }),
    );
    const searchWorkspacePaths = vi.fn(
      async (): Promise<PathSearchResult> => ({
        requestId: "paths-1",
        basePath: "/workspace",
        query: "",
        entries: [
          { path: "src", name: "src", type: "directory" },
          {
            path: "notes with spaces.md",
            name: "notes with spaces.md",
            type: "file",
          },
        ],
      }),
    );

    render(
      <ComposerHarness
        onListAgentSkills={listAgentSkills}
        onSearchWorkspacePaths={searchWorkspacePaths}
      />,
    );

    const composer = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.change(composer, { target: { value: "Open @" } });

    await screen.findByText("@src/");
    fireEvent.keyDown(composer, { key: "ArrowDown", code: "ArrowDown" });
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });

    await waitFor(() =>
      expect(composer).toHaveValue('Open @"notes with spaces.md"'),
    );
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
    expect(searchWorkspacePaths).toHaveBeenCalledWith({
      runnerId: "runner-1",
      basePath: "/workspace",
      query: "",
      limit: 50,
    });
  });

  it("dismisses suggestions after inserting a directory path", async () => {
    const listAgentSkills = vi.fn(
      async (): Promise<AgentSkillListResult> => ({
        requestId: "skills-1",
        agent: "codex",
        basePath: "/workspace",
        queriedAt: "2026-06-20T00:00:00.000Z",
        skills: [],
      }),
    );
    const searchWorkspacePaths = vi.fn(
      async (): Promise<PathSearchResult> => ({
        requestId: "paths-1",
        basePath: "/workspace",
        query: "",
        entries: [{ path: "src", name: "src", type: "directory" }],
      }),
    );

    render(
      <ComposerHarness
        onListAgentSkills={listAgentSkills}
        onSearchWorkspacePaths={searchWorkspacePaths}
      />,
    );

    const composer = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.change(composer, { target: { value: "Open @" } });

    await screen.findByText("@src/");
    fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });

    await waitFor(() => expect(composer).toHaveValue("Open @src/"));
    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
  });

  it("closes the suggestion panel when the composer loses focus", async () => {
    const listAgentSkills = vi.fn(
      async (): Promise<AgentSkillListResult> => ({
        requestId: "skills-1",
        agent: "codex",
        basePath: "/workspace",
        queriedAt: "2026-06-20T00:00:00.000Z",
        skills: [
          {
            name: "plan",
            description: "Plan work",
            sourceType: "project",
            sourcePath: "/workspace/.codex/skills/plan",
          },
        ],
      }),
    );
    const searchWorkspacePaths = vi.fn(
      async (): Promise<PathSearchResult> => ({
        requestId: "paths-1",
        basePath: "/workspace",
        query: "",
        entries: [],
      }),
    );

    render(
      <>
        <ComposerHarness
          onListAgentSkills={listAgentSkills}
          onSearchWorkspacePaths={searchWorkspacePaths}
        />
        <button type="button">Outside</button>
      </>,
    );

    const composer = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.change(composer, { target: { value: "Use $" } });

    await screen.findByText("$plan");
    fireEvent.blur(composer);

    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
  });

  it("dismisses suggestions with Escape", async () => {
    const listAgentSkills = vi.fn(
      async (): Promise<AgentSkillListResult> => ({
        requestId: "skills-1",
        agent: "codex",
        basePath: "/workspace",
        queriedAt: "2026-06-20T00:00:00.000Z",
        skills: [
          {
            name: "plan",
            description: "Plan work",
            sourceType: "project",
            sourcePath: "/workspace/.codex/skills/plan",
          },
        ],
      }),
    );
    const searchWorkspacePaths = vi.fn(
      async (): Promise<PathSearchResult> => ({
        requestId: "paths-1",
        basePath: "/workspace",
        query: "",
        entries: [],
      }),
    );

    render(
      <ComposerHarness
        onListAgentSkills={listAgentSkills}
        onSearchWorkspacePaths={searchWorkspacePaths}
      />,
    );

    const composer = screen.getByRole("textbox", { name: "Prompt" });
    fireEvent.change(composer, { target: { value: "Use $" } });

    await screen.findByText("$plan");
    fireEvent.keyDown(composer, { key: "Escape", code: "Escape" });
    fireEvent.keyUp(composer, { key: "Escape", code: "Escape" });
    fireEvent.select(composer);

    await waitFor(() => {
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });
  });

  it("can render suggestions below the composer", async () => {
    const listAgentSkills = vi.fn(
      async (): Promise<AgentSkillListResult> => ({
        requestId: "skills-1",
        agent: "codex",
        basePath: "/workspace",
        queriedAt: "2026-06-20T00:00:00.000Z",
        skills: [
          {
            name: "plan",
            description: "Plan work",
            sourceType: "project",
            sourcePath: "/workspace/.codex/skills/plan",
          },
        ],
      }),
    );
    const searchWorkspacePaths = vi.fn(
      async (): Promise<PathSearchResult> => ({
        requestId: "paths-1",
        basePath: "/workspace",
        query: "",
        entries: [],
      }),
    );

    render(
      <ComposerHarness
        onListAgentSkills={listAgentSkills}
        onSearchWorkspacePaths={searchWorkspacePaths}
        suggestionPlacement="below"
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Prompt" }), {
      target: { value: "Use $" },
    });

    expect(await screen.findByRole("listbox")).toHaveClass("below");
  });

  it("opens prompt presets, refreshes, inserts at the caret, and manages presets", async () => {
    const refreshPromptPresets = vi.fn(async () => promptPresets);
    const managePromptPresets = vi.fn();

    render(
      <ComposerHarness
        initialValue="Before"
        onListAgentSkills={emptyAgentSkillList}
        onSearchWorkspacePaths={emptyPathSearch}
        promptPresets={promptPresets}
        onRefreshPromptPresets={refreshPromptPresets}
        onManagePromptPresets={managePromptPresets}
      />,
    );

    const composer = screen.getByRole("textbox", { name: "Prompt" });
    if (!(composer instanceof HTMLTextAreaElement)) {
      throw new Error("Prompt composer did not render a textarea.");
    }
    composer.focus();
    composer.setSelectionRange("Before".length, "Before".length);

    fireEvent.click(screen.getByRole("button", { name: "Prompt presets" }));
    expect(await screen.findByText("Review brief")).toBeInTheDocument();
    await waitFor(() => expect(refreshPromptPresets).toHaveBeenCalledTimes(1));

    fireEvent.click(
      screen.getByRole("button", { name: "Refresh prompt presets" }),
    );
    await waitFor(() => expect(refreshPromptPresets).toHaveBeenCalledTimes(2));

    const presetOption = screen.getByText("Review brief").closest("button");
    if (!presetOption) {
      throw new Error("Prompt preset option button was not found.");
    }
    fireEvent.mouseDown(presetOption);
    await waitFor(() =>
      expect(composer).toHaveValue("Before\n\nRun tests\nCheck UI"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Prompt presets" }));
    const manageButton = await screen.findByRole("button", {
      name: "Manage prompts",
    });
    fireEvent.click(manageButton, { detail: 0 });
    expect(managePromptPresets).toHaveBeenCalledTimes(1);
  });

  it("does not auto-refresh prompt presets again after an error state", async () => {
    const refreshPromptPresets = vi.fn(async () => promptPresets);

    render(
      <ComposerHarness
        onListAgentSkills={emptyAgentSkillList}
        onSearchWorkspacePaths={emptyPathSearch}
        promptPresets={[]}
        promptPresetState="error"
        onRefreshPromptPresets={refreshPromptPresets}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Prompt presets" }));

    expect(await screen.findByText("No prompt presets yet")).toBeInTheDocument();
    expect(refreshPromptPresets).not.toHaveBeenCalled();
  });

  it("supports keyboard activation in the prompt preset picker", async () => {
    const managePromptPresets = vi.fn();

    render(
      <ComposerHarness
        initialValue="Before"
        onListAgentSkills={emptyAgentSkillList}
        onSearchWorkspacePaths={emptyPathSearch}
        promptPresets={promptPresets}
        promptPresetState="ready"
        onRefreshPromptPresets={vi.fn(async () => promptPresets)}
        onManagePromptPresets={managePromptPresets}
      />,
    );

    const composer = screen.getByRole("textbox", { name: "Prompt" });
    if (!(composer instanceof HTMLTextAreaElement)) {
      throw new Error("Prompt composer did not render a textarea.");
    }
    composer.focus();
    composer.setSelectionRange("Before".length, "Before".length);

    fireEvent.click(screen.getByRole("button", { name: "Prompt presets" }));
    const presetOption = await screen.findByRole("button", {
      name: /Review brief/,
    });
    fireEvent.click(presetOption, { detail: 0 });
    await waitFor(() =>
      expect(composer).toHaveValue("Before\n\nRun tests\nCheck UI"),
    );

    fireEvent.click(screen.getByRole("button", { name: "Prompt presets" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Manage prompts" }),
      { detail: 0 },
    );
    expect(managePromptPresets).toHaveBeenCalledTimes(1);
  });

  it("prevents Enter in prompt preset search from submitting the surrounding form", async () => {
    render(
      <ComposerHarness
        onListAgentSkills={emptyAgentSkillList}
        onSearchWorkspacePaths={emptyPathSearch}
        promptPresets={promptPresets}
        promptPresetState="ready"
        onRefreshPromptPresets={vi.fn(async () => promptPresets)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Prompt presets" }));
    const searchInput = await screen.findByRole("textbox", {
      name: "Search prompt presets",
    });
    const enterEvent = createEvent.keyDown(searchInput, {
      key: "Enter",
      code: "Enter",
    });
    fireEvent(searchInput, enterEvent);

    expect(enterEvent.defaultPrevented).toBe(true);
  });
});

function ComposerHarness({
  onListAgentSkills,
  onSearchWorkspacePaths,
  suggestionPlacement,
  agent = "codex",
  initialValue = "",
  promptPresets,
  promptPresetState,
  onRefreshPromptPresets,
  onManagePromptPresets,
}: {
  onListAgentSkills: ComponentProps<typeof PromptComposer>["onListAgentSkills"];
  onSearchWorkspacePaths: ComponentProps<
    typeof PromptComposer
  >["onSearchWorkspacePaths"];
  suggestionPlacement?: ComponentProps<
    typeof PromptComposer
  >["suggestionPlacement"];
  agent?: ComponentProps<typeof PromptComposer>["agent"];
  initialValue?: string;
  promptPresets?: ComponentProps<typeof PromptComposer>["promptPresets"];
  promptPresetState?: ComponentProps<
    typeof PromptComposer
  >["promptPresetState"];
  onRefreshPromptPresets?: ComponentProps<
    typeof PromptComposer
  >["onRefreshPromptPresets"];
  onManagePromptPresets?: ComponentProps<
    typeof PromptComposer
  >["onManagePromptPresets"];
}) {
  const [value, setValue] = useState(initialValue);
  const placementProps =
    suggestionPlacement === undefined ? {} : { suggestionPlacement };
  const promptPresetProps: Partial<ComponentProps<typeof PromptComposer>> = {};
  if (promptPresets !== undefined) {
    promptPresetProps.promptPresets = promptPresets;
  }
  if (promptPresetState !== undefined) {
    promptPresetProps.promptPresetState = promptPresetState;
  }
  if (onRefreshPromptPresets !== undefined) {
    promptPresetProps.onRefreshPromptPresets = onRefreshPromptPresets;
  }
  if (onManagePromptPresets !== undefined) {
    promptPresetProps.onManagePromptPresets = onManagePromptPresets;
  }
  return (
    <PromptComposer
      value={value}
      onChange={setValue}
      runnerId="runner-1"
      agent={agent}
      basePath="/workspace"
      onListAgentSkills={onListAgentSkills}
      onSearchWorkspacePaths={onSearchWorkspacePaths}
      ariaLabel="Prompt"
      rows={4}
      {...placementProps}
      {...promptPresetProps}
    />
  );
}

const promptPresets: ProjectPromptPreset[] = [
  {
    id: "promptPreset-1",
    projectId: "project-1",
    title: "Review brief",
    content: "Run tests\nCheck UI",
    order: 0,
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
  },
];

async function emptyAgentSkillList(): Promise<AgentSkillListResult> {
  return {
    requestId: "skills-empty",
    agent: "codex",
    basePath: "/workspace",
    queriedAt: "2026-06-26T00:00:00.000Z",
    skills: [],
  };
}

async function emptyPathSearch(): Promise<PathSearchResult> {
  return {
    requestId: "paths-empty",
    basePath: "/workspace",
    query: "",
    entries: [],
  };
}
