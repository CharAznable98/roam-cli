import type { AgentKind, RunnerRegistration } from "@roamcli/protocol";
import { Send } from "lucide-react";
import { FormEvent, useMemo, useState } from "react";

type NewSessionFormProps = {
  runner: RunnerRegistration;
  onCreate: (values: { title: string; cwd: string; prompt: string; agent: AgentKind }) => void;
};

export function NewSessionForm({ runner, onCreate }: NewSessionFormProps) {
  const [title, setTitle] = useState("");
  const [cwd, setCwd] = useState(runner.workspaceRoot);
  const [prompt, setPrompt] = useState("");
  const agentOptions = useMemo(() => runner.capabilities.map((capability) => capability.kind), [runner.capabilities]);
  const [agent, setAgent] = useState<AgentKind>(runner.capabilities[0]?.kind ?? "mock");

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) {
      return;
    }

    onCreate({
      title: title.trim() || cleanPrompt.slice(0, 48),
      cwd: cwd.trim() || runner.workspaceRoot,
      prompt: cleanPrompt,
      agent
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
          {agentOptions.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Working directory</span>
        <input value={cwd} onChange={(event) => setCwd(event.target.value)} />
      </label>
      <label className="field">
        <span>Prompt</span>
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} placeholder="Describe the work" />
      </label>
    </form>
  );
}
