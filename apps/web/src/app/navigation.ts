import { Bell, Files, MessageSquare } from "lucide-react";

export type WorkspaceTab = "chat" | "files" | "approvals";

export const workspaceTabs: Array<{
  id: WorkspaceTab;
  label: string;
  icon: typeof MessageSquare;
}> = [
  { id: "chat", label: "Conversation", icon: MessageSquare },
  { id: "files", label: "Files", icon: Files },
  { id: "approvals", label: "Approvals", icon: Bell },
];
