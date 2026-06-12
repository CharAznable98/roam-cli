import type { AgentOutputParser } from "@roamcli/agent-plugin-sdk";
import type { RunnerEvent, Session } from "@roamcli/shared/protocol";
import type { AgentProcess } from "../agents/process.js";

export type RunnerEventSink = (event: RunnerEvent) => Promise<void> | void;

export interface RunningSession {
  session: Session;
  child: AgentProcess;
  parser: AgentOutputParser;
  stopRequested: boolean;
  outputTasks: Set<Promise<void>>;
  stopTimer?: ReturnType<typeof setTimeout>;
}
