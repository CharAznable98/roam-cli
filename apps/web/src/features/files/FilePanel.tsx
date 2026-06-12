import type { FileNode } from "@roamcli/shared/protocol";
import { ChevronRight, FileCode2, Folder, Pencil, Save } from "lucide-react";
import { useState, type KeyboardEvent } from "react";

type FilePanelProps = {
  files: FileNode[];
  treeState: "idle" | "loading" | "ready" | "error";
  selectedPath: string;
  fileContent: {
    path: string;
    content: string;
    truncated: boolean;
    encoding: string;
  } | undefined;
  editorContent: string;
  contentState: "idle" | "loading" | "ready" | "error";
  saveState: "idle" | "loading" | "ready" | "error";
  onSelectFile: (path: string) => void;
  onChangeContent: (content: string) => void;
  onSaveFile: () => void;
};

export function FilePanel({
  files,
  treeState,
  selectedPath,
  fileContent,
  editorContent,
  contentState,
  saveState,
  onSelectFile,
  onChangeContent,
  onSaveFile
}: FilePanelProps) {
  const visibleContent = fileContent?.path === selectedPath ? fileContent : undefined;
  const isDirty = visibleContent !== undefined && editorContent !== visibleContent.content;
  const canEdit = visibleContent !== undefined && !visibleContent.truncated;
  const canSave = canEdit && isDirty && saveState !== "loading";

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (canSave) {
        onSaveFile();
      }
    }
  };

  return (
    <section className="tool-panel" aria-label="Files">
      <div className="tool-panel-header">
        <h2 className="panel-title">Files</h2>
        <span className={`stream-status ${treeState}`}>tree {treeState}</span>
      </div>
      <div className="file-grid">
        <div className="file-tree" role="tree">
          {treeState === "loading" ? <div className="empty-state compact">Loading file tree...</div> : null}
          {treeState === "error" ? <div className="empty-state compact">File tree could not be loaded.</div> : null}
          {treeState === "ready" && files.length === 0 ? <div className="empty-state compact">No files returned for this session.</div> : null}
          {files.map((node) => <TreeNode key={node.path} node={node} selectedPath={selectedPath} onSelect={onSelectFile} />)}
        </div>
        <div className="editor-placeholder">
          <div>
            <div className="editor-header">
              <div className="min-w-0">
                <p className="text-xs uppercase text-ink-500">Viewer</p>
                <h3>{selectedPath || "No file selected"}</h3>
              </div>
              <div className="editor-status" aria-label="File save status">
                <span className={`editor-state-badge ${canEdit ? "editable" : "readonly"}`}>
                  <Pencil size={13} />
                  {canEdit ? "Editable" : "Read-only"}
                </span>
                <span className={`editor-state-badge ${saveState === "error" ? "error" : isDirty ? "dirty" : "saved"}`}>
                  <Save size={13} />
                  {saveState === "loading" ? "Saving" : saveState === "error" ? "Error" : isDirty ? "Unsaved" : "Saved"}
                </span>
                <button className="icon-button" type="button" aria-label="Save file" title="Save file" disabled={!canSave} onClick={onSaveFile}>
                  <Save size={15} />
                </button>
              </div>
            </div>
            {visibleContent ? (
              <>
                <p className="text-xs text-ink-500">
                  {visibleContent.encoding}
                  {visibleContent.truncated ? " · truncated" : ""}
                </p>
                <textarea
                  className="code-editor"
                  value={editorContent}
                  onChange={(event) => onChangeContent(event.target.value)}
                  onKeyDown={keyDown}
                  spellCheck={false}
                  disabled={!canEdit || saveState === "loading"}
                  aria-label={`Edit ${visibleContent.path}`}
                />
              </>
            ) : (
              <pre>{contentMessage(selectedPath, contentState)}</pre>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function contentMessage(selectedPath: string, contentState: FilePanelProps["contentState"]) {
  if (!selectedPath) return "Select a file from the tree to load its contents.";
  if (contentState === "loading") return "Loading file content...";
  if (contentState === "error") return "File content could not be loaded.";
  return "Select a file from the tree to load its contents.";
}

function TreeNode({
  node,
  selectedPath,
  onSelect,
  depth = 0
}: {
  node: FileNode;
  selectedPath: string;
  onSelect: (path: string) => void;
  depth?: number;
}) {
  const [isOpen, setIsOpen] = useState(depth < 1);
  const isDirectory = node.type === "directory";
  const isSelected = selectedPath === node.path;

  return (
    <div>
      <button
        type="button"
        role="treeitem"
        aria-expanded={isDirectory ? isOpen : undefined}
        className={`tree-row ${isSelected ? "is-selected" : ""}`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={() => {
          if (isDirectory) {
            setIsOpen((value) => !value);
          } else {
            onSelect(node.path);
          }
        }}
      >
        {isDirectory ? <ChevronRight className={isOpen ? "rotate-90" : ""} size={15} /> : <FileCode2 size={15} />}
        {isDirectory ? <Folder size={15} /> : null}
        <span className="truncate">{node.name}</span>
      </button>
      {isDirectory && isOpen && node.children?.map((child) => (
        <TreeNode key={child.path} node={child} selectedPath={selectedPath} onSelect={onSelect} depth={depth + 1} />
      ))}
    </div>
  );
}
