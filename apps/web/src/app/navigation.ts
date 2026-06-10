import { Bell, Files, MessageSquare, SquareTerminal } from "lucide-react";

export type WorkspaceTab = "chat" | "files" | "terminal" | "approvals";

export const workspaceTabs: Array<{
  id: WorkspaceTab;
  label: string;
  icon: typeof MessageSquare;
}> = [
  { id: "chat", label: "Conversation", icon: MessageSquare },
  { id: "files", label: "Files", icon: Files },
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "approvals", label: "Approvals", icon: Bell },
];
