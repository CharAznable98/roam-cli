import type { AgentKind, ExecutionMode, Project, RunnerCapability, RunnerRegistration } from "@roamcli/protocol";
import { Send } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";

type NewSessionFormProps = {
  project: Project;
  runner: RunnerRegistration;
  onCreate: (values: { title: string; prompt: string; agent: AgentKind; executionMode: ExecutionMode }) => void;
};

export function NewSessionForm({ project, runner, onCreate }: NewSessionFormProps) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("direct");
  const agentOptions = useMemo(() => runner.capabilities.map((capability: RunnerCapability) => capability.kind), [runner.capabilities]);
  const [agent, setAgent] = useState<AgentKind>(runner.capabilities[0]?.kind ?? "codex");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) {
      return;
    }

    onCreate({
      title: title.trim() || cleanPrompt.slice(0, 48),
      prompt: cleanPrompt,
      agent,
      executionMode
    });
    setTitle("");
    setPrompt("");
  };

  return (
    <form className="new-session-form" onSubmit={submit}>
      <div className="flex items-center justify-between">
        <h2 className="panel-title">New Session</h2>
        <button className="primary-icon-button" type="submit" aria-label="Create session" title="Create session">
          <Send size={16} />
        </button>
      </div>
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
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} placeholder="Describe the work" />
      </label>
    </form>
  );
}
