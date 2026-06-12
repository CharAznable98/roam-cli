import type { AgentKind, ExecutionMode, Project, RunnerCapability, RunnerRegistration } from "@roamcli/shared/protocol";
import { Send } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";

export type NewSessionValues = {
  title: string;
  prompt: string;
  agent: AgentKind;
  executionMode: ExecutionMode;
};

type NewSessionFormProps = {
  project: Project;
  runner: RunnerRegistration;
  onCreate: (values: NewSessionValues) => void | Promise<void>;
  onCreated?: () => void;
};

export function NewSessionForm({ project, runner, onCreate, onCreated }: NewSessionFormProps) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("direct");
  const agentOptions = useMemo(() => runner.capabilities.map((capability: RunnerCapability) => capability.kind), [runner.capabilities]);
  const [agent, setAgent] = useState<AgentKind>(runner.capabilities[0]?.kind ?? "codex");

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) {
      setError("Prompt is required.");
      return;
    }

    setSubmitting(true);
    try {
      await onCreate({
        title: title.trim() || cleanPrompt.slice(0, 48),
        prompt: cleanPrompt,
        agent,
        executionMode
      });
      setTitle("");
      setPrompt("");
      setError("");
      onCreated?.();
    } catch (createError: unknown) {
      setError(errorMessage(createError, "Session was not created."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="new-session-form" onSubmit={submit}>
      <label className="field">
        <span>Title</span>
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Optional task name" />
      </label>
      <label className="field">
        <span>Agent</span>
        <select value={agent} onChange={(event) => setAgent(event.target.value as AgentKind)}>
          {agentOptions.map((option: AgentKind) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Project directory</span>
        <input value={project.directory} readOnly />
      </label>
      <label className="field">
        <span>Execution</span>
        <select value={executionMode} onChange={(event) => setExecutionMode(event.target.value as ExecutionMode)}>
          <option value="direct">Direct</option>
          <option value="managed_worktree">Managed worktree</option>
        </select>
      </label>
      <label className="field">
        <span>Prompt</span>
        <textarea
          value={prompt}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setPrompt(event.target.value);
            setError("");
          }}
          rows={4}
          placeholder="Describe the work"
        />
      </label>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="form-actions">
        <button className="primary-action-button" type="submit" title="Create session" disabled={submitting}>
          <Send size={16} />
          <span>{submitting ? "Creating session..." : "Create session"}</span>
        </button>
      </div>
    </form>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
