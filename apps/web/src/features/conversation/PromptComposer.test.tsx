// @vitest-environment jsdom
import "../../test/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AgentSkillListResult,
  PathSearchResult,
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
});

function ComposerHarness({
  onListAgentSkills,
  onSearchWorkspacePaths,
  suggestionPlacement,
}: {
  onListAgentSkills: ComponentProps<typeof PromptComposer>["onListAgentSkills"];
  onSearchWorkspacePaths: ComponentProps<
    typeof PromptComposer
  >["onSearchWorkspacePaths"];
  suggestionPlacement?: ComponentProps<
    typeof PromptComposer
  >["suggestionPlacement"];
}) {
  const [value, setValue] = useState("");
  const placementProps =
    suggestionPlacement === undefined ? {} : { suggestionPlacement };
  return (
    <PromptComposer
      value={value}
      onChange={setValue}
      runnerId="runner-1"
      agent="codex"
      basePath="/workspace"
      onListAgentSkills={onListAgentSkills}
      onSearchWorkspacePaths={onSearchWorkspacePaths}
      ariaLabel="Prompt"
      rows={4}
      {...placementProps}
    />
  );
}
