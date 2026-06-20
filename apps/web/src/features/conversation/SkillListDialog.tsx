import type { AgentKind, AgentSkillSummary } from "@roamcli/shared/protocol";
import { LoaderCircle, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getCachedAgentSkills,
  isAgentSkillCacheFresh,
  refreshAgentSkills,
  type AgentSkillFetcher,
  type PromptResourceScope,
} from "./prompt-resources";

type SkillListDialogProps = {
  runnerId: string;
  agent: AgentKind;
  basePath: string;
  onListAgentSkills: AgentSkillFetcher;
  onClose: () => void;
};

type SkillListState = {
  status: "idle" | "loading" | "ready" | "error";
  skills: AgentSkillSummary[];
  queriedAt?: string;
  error?: string;
};

export function SkillListDialog({
  runnerId,
  agent,
  basePath,
  onListAgentSkills,
  onClose,
}: SkillListDialogProps) {
  const scope = useMemo<PromptResourceScope>(
    () => ({ runnerId, agent, basePath }),
    [agent, basePath, runnerId],
  );
  const [state, setState] = useState<SkillListState>({
    status: "idle",
    skills: [],
  });

  const loadSkills = useCallback(
    async (force: boolean) => {
      const cached = getCachedAgentSkills(scope);
      if (!force && cached) {
        setState({
          status: isAgentSkillCacheFresh(cached) ? "ready" : "loading",
          skills: cached.result.skills,
          queriedAt: cached.result.queriedAt,
        });
        if (isAgentSkillCacheFresh(cached)) {
          return;
        }
      } else {
        setState((current) => ({
          status: "loading",
          skills: current.skills,
          ...(current.queriedAt ? { queriedAt: current.queriedAt } : {}),
        }));
      }

      try {
        const entry = await refreshAgentSkills(scope, onListAgentSkills);
        setState({
          status: "ready",
          skills: entry.result.skills,
          queriedAt: entry.result.queriedAt,
        });
      } catch (error) {
        setState((current) => ({
          ...current,
          status: current.skills.length > 0 ? "ready" : "error",
          error: getErrorMessage(error, "Skill list failed."),
        }));
      }
    },
    [onListAgentSkills, scope],
  );

  useEffect(() => {
    void loadSkills(false);
  }, [loadSkills]);

  const loading = state.status === "loading";

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="modal-panel skill-list-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-list-title"
      >
        <div className="modal-header">
          <div>
            <h2 id="skill-list-title" className="panel-title">
              Skill list
            </h2>
            <p className="skill-list-timestamp">
              Last queried:{" "}
              {state.queriedAt ? formatDateTime(state.queriedAt) : "never"}
            </p>
          </div>
          <div className="skill-list-header-actions">
            <button
              className="icon-button"
              type="button"
              aria-label="Refresh skill list"
              title="Refresh skill list"
              disabled={loading}
              onClick={() => void loadSkills(true)}
            >
              <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="Close skill list"
              title="Close"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {loading && state.skills.length === 0 ? (
          <div className="skill-list-state">
            <LoaderCircle size={16} className="animate-spin" />
            <span>Loading skills</span>
          </div>
        ) : null}
        {state.error && state.skills.length === 0 ? (
          <p className="form-error">{state.error}</p>
        ) : null}
        {!loading && !state.error && state.skills.length === 0 ? (
          <div className="skill-list-empty">No skills found.</div>
        ) : null}
        {state.skills.length > 0 ? (
          <div className="skill-list" role="list">
            {state.skills.map((skill) => (
              <div className="skill-list-row" key={skill.name} role="listitem">
                <div className="skill-list-row-main">
                  <strong>${skill.name}</strong>
                  {skill.description ? <span>{skill.description}</span> : null}
                </div>
                <div className="skill-list-row-meta">
                  <span>{skill.sourceType}</span>
                  <code>{skill.sourcePath}</code>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
