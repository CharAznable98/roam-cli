import type {
  AgentKind,
  AgentSkillSummary,
  PathSearchEntry,
  ProjectPromptPreset,
} from "@roamcli/shared/protocol";
import { BookOpen, LoaderCircle, RefreshCw } from "lucide-react";
import {
  ClipboardEvent,
  KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  getCachedAgentSkills,
  getCachedPathSearch,
  isAgentSkillCacheFresh,
  isPathSearchCacheFresh,
  refreshAgentSkills,
  refreshPathSearch,
  type AgentSkillFetcher,
  type PathSearchFetcher,
  type PromptResourceScope,
} from "./prompt-resources";
import type { AsyncState } from "../../shared/types/async";

const PATH_SEARCH_LIMIT = 50;
const PANEL_OPTION_LIMIT = 8;
const PATH_SEARCH_DEBOUNCE_MS = 140;

type PromptComposerProps = {
  value: string;
  onChange: (value: string) => void;
  runnerId: string;
  agent: AgentKind;
  basePath: string;
  onListAgentSkills: AgentSkillFetcher;
  onSearchWorkspacePaths: PathSearchFetcher;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  rows?: number;
  placeholder?: string;
  ariaLabel: string;
  ariaInvalid?: boolean;
  disabled?: boolean;
  suggestionPlacement?: "above" | "below";
  promptPresets?: ProjectPromptPreset[];
  promptPresetState?: AsyncState;
  onRefreshPromptPresets?: (() => Promise<ProjectPromptPreset[]>) | undefined;
  onManagePromptPresets?: (() => void) | undefined;
};

type TriggerToken = {
  type: "skill" | "path";
  marker: "$" | "/" | "@";
  start: number;
  end: number;
  query: string;
};

type SkillState = {
  status: "idle" | "loading" | "ready" | "error";
  skills: AgentSkillSummary[];
  queriedAt?: string;
  error?: string;
};

type PathState = {
  status: "idle" | "loading" | "ready" | "error";
  entries: PathSearchEntry[];
  error?: string;
};

type CompletionOption =
  | { kind: "skill"; skill: AgentSkillSummary }
  | { kind: "path"; entry: PathSearchEntry };

export function PromptComposer({
  value,
  onChange,
  runnerId,
  agent,
  basePath,
  onListAgentSkills,
  onSearchWorkspacePaths,
  onKeyDown,
  onPaste,
  rows = 2,
  placeholder,
  ariaLabel,
  ariaInvalid,
  disabled,
  suggestionPlacement = "above",
  promptPresets = [],
  promptPresetState = "idle",
  onRefreshPromptPresets,
  onManagePromptPresets,
}: PromptComposerProps) {
  const suggestionPanelId = `${useId()}-suggestions`;
  const promptPresetPanelId = `${useId()}-prompt-presets`;
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestionPanelRef = useRef<HTMLDivElement>(null);
  const pendingSelectionRef = useRef<number | undefined>(undefined);
  const promptPickerMouseHandledRef = useRef(false);
  const pathRequestRef = useRef(0);
  const [caret, setCaret] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);
  const [skillState, setSkillState] = useState<SkillState>({
    status: "idle",
    skills: [],
  });
  const [pathState, setPathState] = useState<PathState>({
    status: "idle",
    entries: [],
  });
  const [dismissedTokenKey, setDismissedTokenKey] = useState<
    string | undefined
  >();
  const [promptPickerOpen, setPromptPickerOpen] = useState(false);
  const [promptPresetQuery, setPromptPresetQuery] = useState("");
  const [promptPresetError, setPromptPresetError] = useState<string>();
  const scope = useMemo<PromptResourceScope>(
    () => ({ runnerId, agent, basePath }),
    [agent, basePath, runnerId],
  );
  const rawToken = useMemo(
    () => findTriggerToken(value, caret),
    [caret, value],
  );
  const token = useMemo(() => {
    if (!rawToken || triggerTokenKey(rawToken) === dismissedTokenKey) {
      return undefined;
    }
    return rawToken;
  }, [dismissedTokenKey, rawToken]);

  useEffect(() => {
    const selection = pendingSelectionRef.current;
    if (selection === undefined) {
      return;
    }
    pendingSelectionRef.current = undefined;
    textareaRef.current?.setSelectionRange(selection, selection);
    setCaret(selection);
  }, [value]);

  useEffect(() => {
    if (token?.type !== "skill") {
      return;
    }

    const cached = getCachedAgentSkills(scope);
    if (cached) {
      setSkillState({
        status: isAgentSkillCacheFresh(cached) ? "ready" : "loading",
        skills: cached.result.skills,
        queriedAt: cached.result.queriedAt,
      });
      if (isAgentSkillCacheFresh(cached)) {
        return;
      }
    } else {
      setSkillState({ status: "loading", skills: [] });
    }

    let cancelled = false;
    void refreshAgentSkills(scope, onListAgentSkills)
      .then((entry) => {
        if (!cancelled) {
          setSkillState({
            status: "ready",
            skills: entry.result.skills,
            queriedAt: entry.result.queriedAt,
          });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSkillState((current) => ({
            ...current,
            status: current.skills.length > 0 ? "ready" : "error",
            error: getErrorMessage(error, "Skill list failed."),
          }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [onListAgentSkills, scope, token?.type]);

  useEffect(() => {
    if (token?.type !== "path") {
      return;
    }

    const query = token.query;
    const cached = getCachedPathSearch(scope, query, PATH_SEARCH_LIMIT);
    if (cached) {
      setPathState({
        status: isPathSearchCacheFresh(cached) ? "ready" : "loading",
        entries: cached.result.entries,
      });
      if (isPathSearchCacheFresh(cached)) {
        return;
      }
    } else {
      setPathState({ status: "loading", entries: [] });
    }

    const requestId = pathRequestRef.current + 1;
    pathRequestRef.current = requestId;
    const timer = globalThis.setTimeout(() => {
      void refreshPathSearch(
        scope,
        query,
        PATH_SEARCH_LIMIT,
        onSearchWorkspacePaths,
      )
        .then((entry) => {
          if (pathRequestRef.current === requestId) {
            setPathState({ status: "ready", entries: entry.result.entries });
          }
        })
        .catch((error: unknown) => {
          if (pathRequestRef.current === requestId) {
            setPathState((current) => ({
              ...current,
              status: current.entries.length > 0 ? "ready" : "error",
              error: getErrorMessage(error, "Path search failed."),
            }));
          }
        });
    }, PATH_SEARCH_DEBOUNCE_MS);

    return () => globalThis.clearTimeout(timer);
  }, [onSearchWorkspacePaths, scope, token?.query, token?.type]);

  const options = useMemo<CompletionOption[]>(() => {
    if (!token) {
      return [];
    }
    if (token.type === "skill") {
      const query = token.query.trim().toLowerCase();
      const slashTrigger = token.marker === "/";
      return skillState.skills
        .filter((skill) => {
          const insertText = skillInsertText(skill);
          if (slashTrigger !== insertText.startsWith("/")) {
            return false;
          }
          if (!query) {
            return true;
          }
          return (
            skill.name.toLowerCase().includes(query) ||
            insertText.toLowerCase().includes(query) ||
            (skill.description?.toLowerCase().includes(query) ?? false)
          );
        })
        .slice(0, PANEL_OPTION_LIMIT)
        .map((skill) => ({ kind: "skill", skill }));
    }
    return pathState.entries
      .slice(0, PANEL_OPTION_LIMIT)
      .map((entry) => ({ kind: "path", entry }));
  }, [pathState.entries, skillState.skills, token]);

  useEffect(() => {
    setActiveIndex(0);
  }, [token?.query, token?.type, options.length]);

  const loading =
    token?.type === "skill"
      ? skillState.status === "loading"
      : token?.type === "path"
        ? pathState.status === "loading"
        : false;
  const error =
    token?.type === "skill"
      ? skillState.error
      : token?.type === "path"
        ? pathState.error
        : undefined;
  const panelOpen =
    Boolean(token) &&
    (loading || options.length > 0 || Boolean(error) || hasCompletedEmpty());
  const filteredPromptPresets = useMemo(() => {
    const query = promptPresetQuery.trim().toLowerCase();
    const filtered = query
      ? promptPresets.filter(
          (preset) =>
            preset.title.toLowerCase().includes(query) ||
            preset.content.toLowerCase().includes(query),
        )
      : promptPresets;
    return filtered.slice(0, PANEL_OPTION_LIMIT);
  }, [promptPresetQuery, promptPresets]);

  const refreshPromptPresets = async () => {
    if (!onRefreshPromptPresets) {
      return;
    }
    setPromptPresetError(undefined);
    try {
      await onRefreshPromptPresets();
    } catch (refreshError: unknown) {
      setPromptPresetError(
        getErrorMessage(refreshError, "Prompt presets failed."),
      );
    }
  };

  useEffect(() => {
    if (!panelOpen || suggestionPlacement !== "below") {
      return;
    }
    const frameId = requestAnimationFrame(() => {
      suggestionPanelRef.current?.scrollIntoView?.({
        block: "end",
        inline: "nearest",
      });
    });
    return () => cancelAnimationFrame(frameId);
  }, [loading, options.length, panelOpen, suggestionPlacement]);

  useEffect(() => {
    if (!promptPickerOpen) {
      return;
    }
    promptPickerMouseHandledRef.current = false;
    const closeOnOutsidePointer = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && !composerRef.current?.contains(target)) {
        setPromptPickerOpen(false);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setPromptPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [promptPickerOpen]);

  useEffect(() => {
    if (promptPickerOpen && promptPresetState === "idle") {
      void refreshPromptPresets();
    }
  }, [promptPickerOpen, promptPresetState]);

  function hasCompletedEmpty(): boolean {
    if (!token) {
      return false;
    }
    return token.type === "skill"
      ? skillState.status === "ready" && options.length === 0
      : pathState.status === "ready" && options.length === 0;
  }

  const updateCaret = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      setCaret(textarea.selectionStart);
    }
  };

  const insertOption = (option: CompletionOption) => {
    if (!token) {
      return;
    }
    const replacement =
      option.kind === "skill"
        ? skillInsertText(option.skill)
        : `@${formatPathMention(option.entry)}`;
    const nextValue =
      value.slice(0, token.start) + replacement + value.slice(token.end);
    const nextCaret = token.start + replacement.length;
    const nextToken = findTriggerToken(nextValue, nextCaret);
    pendingSelectionRef.current = nextCaret;
    setDismissedTokenKey(nextToken ? triggerTokenKey(nextToken) : undefined);
    onChange(nextValue);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const isSubmitShortcut = event.metaKey || event.ctrlKey;
    if (event.key === "Enter" && isSubmitShortcut) {
      onKeyDown?.(event);
      return;
    }

    if (event.nativeEvent.isComposing) {
      onKeyDown?.(event);
      return;
    }

    if (event.key === "Escape" && token) {
      event.preventDefault();
      setDismissedTokenKey(triggerTokenKey(token));
      setCaret(-1);
      return;
    }

    if (panelOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((current) =>
          options.length === 0 ? 0 : (current + 1) % options.length,
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((current) =>
          options.length === 0
            ? 0
            : (current - 1 + options.length) % options.length,
        );
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && options.length) {
        event.preventDefault();
        const selectedOption =
          options[Math.min(activeIndex, options.length - 1)];
        if (selectedOption) {
          insertOption(selectedOption);
        }
        return;
      }
    }

    onKeyDown?.(event);
  };

  const insertPromptPreset = (preset: ProjectPromptPreset) => {
    const textarea = textareaRef.current;
    const start =
      textarea?.selectionStart ?? (caret >= 0 ? caret : value.length);
    const end = textarea?.selectionEnd ?? start;
    const insertion = composePromptPresetInsertion(
      value,
      start,
      end,
      preset.content,
    );
    pendingSelectionRef.current = insertion.caret;
    onChange(insertion.value);
    setPromptPickerOpen(false);
    textareaRef.current?.focus();
  };

  return (
    <div className="prompt-composer" ref={composerRef}>
      <div className="prompt-composer-input">
        <textarea
          ref={textareaRef}
          value={value}
          aria-label={ariaLabel}
          aria-invalid={ariaInvalid ? "true" : undefined}
          aria-expanded={panelOpen ? "true" : undefined}
          aria-controls={panelOpen ? suggestionPanelId : undefined}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.target.value);
            setDismissedTokenKey(undefined);
            setCaret(event.target.selectionStart);
          }}
          onBlur={() => {
            setCaret(-1);
          }}
          onClick={updateCaret}
          onKeyDown={handleKeyDown}
          onKeyUp={(event) => {
            if (event.key !== "Escape") {
              updateCaret();
            }
          }}
          onPaste={onPaste}
          onSelect={updateCaret}
          placeholder={placeholder}
          rows={rows}
        />
        {onRefreshPromptPresets ? (
          <button
            className="prompt-preset-trigger"
            type="button"
            aria-label="Prompt presets"
            aria-expanded={promptPickerOpen}
            aria-controls={promptPickerOpen ? promptPresetPanelId : undefined}
            title="Prompt presets"
            disabled={disabled}
            onClick={() => {
              setPromptPickerOpen((open) => !open);
              setPromptPresetError(undefined);
              if (token) {
                setDismissedTokenKey(triggerTokenKey(token));
                setCaret(-1);
              }
            }}
          >
            <BookOpen size={15} />
          </button>
        ) : null}
      </div>
      {promptPickerOpen ? (
        <div
          className={`prompt-preset-panel ${suggestionPlacement}`}
          id={promptPresetPanelId}
          role="dialog"
          aria-label="Prompt presets"
        >
          <div className="prompt-preset-toolbar">
            <input
              value={promptPresetQuery}
              onChange={(event) => setPromptPresetQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }}
              placeholder="Search prompt presets"
              aria-label="Search prompt presets"
            />
            <button
              className="prompt-preset-refresh"
              type="button"
              aria-label="Refresh prompt presets"
              title="Refresh"
              onClick={() => void refreshPromptPresets()}
              disabled={promptPresetState === "loading"}
            >
              <RefreshCw
                size={14}
                className={
                  promptPresetState === "loading" ? "animate-spin" : ""
                }
              />
            </button>
          </div>
          {promptPresetState === "loading" ? (
            <div className="prompt-suggestion-status">
              <LoaderCircle size={15} className="animate-spin" />
              <span>Loading prompt presets</span>
            </div>
          ) : null}
          {promptPresetError ? (
            <div className="prompt-suggestion-empty">{promptPresetError}</div>
          ) : null}
          {promptPresetState !== "loading" &&
          !promptPresetError &&
          filteredPromptPresets.length === 0 ? (
            <div className="prompt-suggestion-empty">
              {promptPresetQuery.trim()
                ? "No prompt presets found"
                : "No prompt presets yet"}
            </div>
          ) : null}
          {filteredPromptPresets.map((preset) => (
            <button
              className="prompt-preset-option"
              key={preset.id}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                promptPickerMouseHandledRef.current = true;
                insertPromptPreset(preset);
              }}
              onClick={() => {
                if (promptPickerMouseHandledRef.current) {
                  promptPickerMouseHandledRef.current = false;
                  return;
                }
                insertPromptPreset(preset);
              }}
            >
              <span className="prompt-suggestion-title">{preset.title}</span>
              <span className="prompt-suggestion-meta">
                {singleLine(preset.content)}
              </span>
            </button>
          ))}
          {onManagePromptPresets ? (
            <button
              className="prompt-preset-manage"
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                promptPickerMouseHandledRef.current = true;
                setPromptPickerOpen(false);
                onManagePromptPresets();
              }}
              onClick={() => {
                if (promptPickerMouseHandledRef.current) {
                  promptPickerMouseHandledRef.current = false;
                  return;
                }
                setPromptPickerOpen(false);
                onManagePromptPresets();
              }}
            >
              Manage prompts
            </button>
          ) : null}
        </div>
      ) : null}
      {panelOpen ? (
        <div
          ref={suggestionPanelRef}
          className={`prompt-suggestion-panel ${suggestionPlacement}`}
          id={suggestionPanelId}
          role="listbox"
          aria-label={`${token?.type === "skill" ? "Skill" : "Path"} suggestions`}
        >
          {loading ? (
            <div className="prompt-suggestion-status">
              <LoaderCircle size={15} className="animate-spin" />
              <span>
                {token?.type === "skill" ? "Loading skills" : "Searching paths"}
              </span>
            </div>
          ) : null}
          {error && options.length === 0 ? (
            <div className="prompt-suggestion-empty">{error}</div>
          ) : null}
          {!loading && !error && options.length === 0 ? (
            <div className="prompt-suggestion-empty">
              {token?.type === "skill" ? "No skills found" : "No paths found"}
            </div>
          ) : null}
          {options.map((option, index) => (
            <button
              className={`prompt-suggestion-option ${
                index === activeIndex ? "active" : ""
              }`}
              key={completionKey(option)}
              role="option"
              aria-selected={index === activeIndex}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                insertOption(option);
              }}
            >
              <span className="prompt-suggestion-title">
                {option.kind === "skill"
                  ? skillInsertText(option.skill)
                  : `@${option.entry.path}${option.entry.type === "directory" ? "/" : ""}`}
              </span>
              <span className="prompt-suggestion-meta">
                {option.kind === "skill"
                  ? option.skill.description || option.skill.sourceType
                  : option.entry.type}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function findTriggerToken(
  value: string,
  caret: number,
): TriggerToken | undefined {
  if (caret < 0 || caret > value.length) {
    return undefined;
  }

  let start = caret;
  while (start > 0 && !/\s/.test(value[start - 1] ?? "")) {
    start -= 1;
  }
  const marker = value[start];
  if (marker !== "$" && marker !== "/" && marker !== "@") {
    return undefined;
  }

  let end = caret;
  while (end < value.length && !/\s/.test(value[end] ?? "")) {
    end += 1;
  }

  const query = value.slice(start + 1, caret);
  if ((marker === "$" || marker === "/") && !/^[A-Za-z0-9_:-]*$/.test(query)) {
    return undefined;
  }
  return {
    type: marker === "@" ? "path" : "skill",
    marker,
    start,
    end,
    query,
  };
}

function skillInsertText(skill: AgentSkillSummary): string {
  return skill.insertText ?? `$${skill.name}`;
}

function formatPathMention(entry: PathSearchEntry): string {
  const path =
    entry.type === "directory" && !entry.path.endsWith("/")
      ? `${entry.path}/`
      : entry.path;
  if (!/[\s"]/.test(path)) {
    return path;
  }
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function completionKey(option: CompletionOption): string {
  return option.kind === "skill"
    ? `skill:${skillInsertText(option.skill)}:${option.skill.sourcePath}`
    : `path:${option.entry.path}`;
}

function triggerTokenKey(token: TriggerToken): string {
  return `${token.type}:${token.marker}:${token.start}:${token.end}:${token.query}`;
}

function composePromptPresetInsertion(
  value: string,
  start: number,
  end: number,
  content: string,
): { value: string; caret: number } {
  const before = value.slice(0, start);
  const after = value.slice(end);
  let inserted = content;
  if (before.length > 0 && !before.endsWith("\n")) {
    inserted = `\n\n${inserted}`;
  }
  if (after.length > 0 && !after.startsWith("\n")) {
    inserted = `${inserted}\n\n`;
  }
  const nextValue = `${before}${inserted}${after}`;
  return {
    value: nextValue,
    caret: before.length + inserted.length,
  };
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
