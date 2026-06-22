import type { AgentSession } from "@roamcli/agent-plugin-sdk";
import type { RunnerEvent, Session } from "@roamcli/shared/protocol";

export type RunnerEventSink = (event: RunnerEvent) => Promise<void> | void;

export interface RunningSession {
  session: Session;
  agentSession: AgentSession;
  stopRequested: boolean;
  stopTimer?: ReturnType<typeof setTimeout>;
}
