import type { Artifact, Message } from "@roamcli/protocol";

export type WorkspaceTab = "chat" | "files" | "terminal" | "approvals";

export type UiMessage = Message & {
  variant?: "message" | "thought" | "tool";
  toolName?: string;
};

export interface SessionDetailPayload {
  session: import("@roamcli/protocol").Session;
  messages: Message[];
  approvals: import("@roamcli/protocol").Approval[];
  artifacts: Artifact[];
}

export interface InitialRemoteState {
  runners: import("@roamcli/protocol").RunnerRegistration[];
  sessions: import("@roamcli/protocol").Session[];
  messages: UiMessage[];
  approvals: import("@roamcli/protocol").Approval[];
  artifacts: Artifact[];
}
