import { Bell, Files, GitBranch, MessageSquare, Settings } from "lucide-react";

export type WorkspaceTab = "chat" | "files" | "git" | "approvals" | "settings";

export const workspaceTabs: Array<{
  id: WorkspaceTab;
  label: string;
  icon: typeof MessageSquare;
}> = [
  { id: "chat", label: "Conversation", icon: MessageSquare },
  { id: "files", label: "Files", icon: Files },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "approvals", label: "Approvals", icon: Bell },
  { id: "settings", label: "Settings", icon: Settings },
];
