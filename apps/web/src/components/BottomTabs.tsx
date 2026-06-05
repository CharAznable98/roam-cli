import { Bell, Files, MessageSquare, SquareTerminal } from "lucide-react";
import type { WorkspaceTab } from "../types";

const tabs: Array<{ id: WorkspaceTab; label: string; icon: typeof MessageSquare }> = [
  { id: "chat", label: "对话", icon: MessageSquare },
  { id: "files", label: "文件", icon: Files },
  { id: "terminal", label: "终端", icon: SquareTerminal },
  { id: "approvals", label: "审批", icon: Bell }
];

export function BottomTabs({ activeTab, onChange }: { activeTab: WorkspaceTab; onChange: (tab: WorkspaceTab) => void }) {
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
