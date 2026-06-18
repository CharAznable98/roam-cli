import { Bell, Files, GitBranch, MessageSquare } from "lucide-react";
import type { WorkspaceTab } from "./navigation";

const tabs: Array<{
  id: WorkspaceTab;
  label: string;
  icon: typeof MessageSquare;
}> = [
  { id: "chat", label: "对话", icon: MessageSquare },
  { id: "files", label: "文件", icon: Files },
  { id: "git", label: "Git", icon: GitBranch },
  { id: "approvals", label: "审批", icon: Bell },
];

export function BottomTabs({
  activeTab,
  onChange,
}: {
  activeTab: WorkspaceTab;
  onChange: (tab: WorkspaceTab) => void;
}) {
  return (
    <nav className="bottom-tabs" aria-label="Mobile tabs">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <button
            key={tab.id}
            type="button"
            className={activeTab === tab.id ? "is-active" : ""}
            onClick={() => onChange(tab.id)}
            aria-current={activeTab === tab.id ? "page" : undefined}
          >
            <Icon size={19} />
            <span>{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
