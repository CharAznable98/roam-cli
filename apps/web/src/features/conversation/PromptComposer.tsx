import type {
  AgentKind,
  AgentSkillSummary,
  PathSearchEntry,
} from "@roamcli/shared/protocol";
import { LoaderCircle } from "lucide-react";
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
}: PromptComposerProps) {
  const suggestionPanelId = `${useId()}-suggestions`;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const suggestionPanelRef = useRef<HTMLDivElement>(null);
  const pendingSelectionRef = useRef<number | undefined>(undefined);
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

  return (
    <div className="prompt-composer">
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

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
