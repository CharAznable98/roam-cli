import { CornerDownLeft, Octagon, Play, Square, SquareTerminal } from "lucide-react";
import { FormEvent, useState } from "react";

type TerminalPanelProps = {
  lines: string[];
  streamState: "open" | "closed" | "error";
  onCommand?: (command: string) => void;
  onControl?: (signal: "interrupt" | "stop" | "resume") => void;
};

export function TerminalPanel({ lines, streamState, onCommand, onControl }: TerminalPanelProps) {
  const [command, setCommand] = useState("");
  const canSend = streamState === "open";

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanCommand = command.trim();
    if (!cleanCommand) {
      return;
    }

    onCommand?.(cleanCommand);
    setCommand("");
  };

  return (
    <section className="tool-panel terminal-panel" aria-label="Terminal">
      <div className="tool-panel-header">
        <h2 className="panel-title">Terminal</h2>
        <div className="terminal-header-actions">
          <button
            className="icon-button terminal-control"
            type="button"
            aria-label="Interrupt session"
            title="Interrupt session"
            disabled={!canSend}
            onClick={() => onControl?.("interrupt")}
          >
            <Octagon size={15} />
          </button>
          <button
            className="icon-button terminal-control"
            type="button"
            aria-label="Stop session"
            title="Stop session"
            disabled={!canSend}
            onClick={() => onControl?.("stop")}
          >
            <Square size={15} />
          </button>
          <button
            className="icon-button terminal-control"
            type="button"
            aria-label="Resume session"
            title="Resume session"
            disabled={!canSend}
            onClick={() => onControl?.("resume")}
          >
            <Play size={15} />
          </button>
          <span className={`stream-status ${streamState}`}>
            <SquareTerminal size={15} />
            stream {streamState}
          </span>
        </div>
      </div>
      <pre className="terminal-output">
        {lines.length === 0 ? <code>No terminal output for the active session yet.</code> : null}
        {lines.map((line, index) => (
          <code key={`${line}-${index}`}>{line}</code>
        ))}
      </pre>
      <form className="terminal-input" onSubmit={submit}>
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder={canSend ? "Send input to active session" : "Stream is disconnected"}
          disabled={!canSend}
        />
        <button className="icon-button" type="submit" aria-label="Send terminal input" title="Send terminal input" disabled={!canSend}>
          <CornerDownLeft size={16} />
        </button>
      </form>
    </section>
  );
}
