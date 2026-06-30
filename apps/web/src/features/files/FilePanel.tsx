import { Editor, type OnMount } from "@monaco-editor/react";
import type { FileContentResult, FileNode } from "@roamcli/shared/protocol";
import {
  Code2,
  Eye,
  Maximize2,
  Minimize2,
  Pencil,
  RefreshCw,
  Save,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MarkdownMessage } from "../conversation/MarkdownMessage";
import { LazyFileTree, type TreePathStates } from "./LazyFileTree";

type FilePanelProps = {
  files: FileNode[];
  treeState: "idle" | "loading" | "ready" | "error";
  treePathStates: TreePathStates;
  selectedPath: string;
  fileContent: FileContentResult | undefined;
  editorContent: string;
  editMode: boolean;
  contentState: "idle" | "loading" | "ready" | "error";
  saveState: "idle" | "loading" | "ready" | "error";
  onSelectFile: (path: string) => void;
  onLoadDirectory: (path: string) => void;
  onRefreshTree: () => void;
  onRefreshFile: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onChangeContent: (content: string) => void;
  onSaveFile: () => void;
  treeId?: string | undefined;
};

export function FilePanel({
  files,
  treeState,
  treePathStates,
  selectedPath,
  fileContent,
  editorContent,
  editMode,
  contentState,
  saveState,
  onSelectFile,
  onLoadDirectory,
  onRefreshTree,
  onRefreshFile,
  onStartEdit,
  onCancelEdit,
  onChangeContent,
  onSaveFile,
  treeId,
}: FilePanelProps) {
  const visibleContent =
    fileContent?.path === selectedPath ? fileContent : undefined;
  const visibleTextContent =
    visibleContent && isTextContent(visibleContent)
      ? visibleContent
      : undefined;
  const isDirty =
    visibleTextContent !== undefined &&
    editorContent !== visibleTextContent.content;
  const canEdit =
    visibleTextContent !== undefined && !visibleTextContent.truncated;
  const isEditing = canEdit && editMode;
  const canSave = isEditing && isDirty && saveState !== "loading";
  const canSaveRef = useRef(canSave);
  const onSaveFileRef = useRef(onSaveFile);
  const [markdownMode, setMarkdownMode] = useState<"rendered" | "source">(
    "rendered",
  );
  const [fullscreen, setFullscreen] = useState(false);
  const isMarkdown =
    visibleTextContent !== undefined && isMarkdownPath(visibleTextContent.path);
  const showRenderedMarkdown =
    visibleTextContent !== undefined &&
    !isEditing &&
    isMarkdown &&
    markdownMode === "rendered";

  useEffect(() => {
    canSaveRef.current = canSave;
    onSaveFileRef.current = onSaveFile;
  }, [canSave, onSaveFile]);

  useEffect(() => {
    setFullscreen(false);
  }, [selectedPath]);

  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFullscreen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreen]);

  const handleEditorMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (canSaveRef.current) {
        onSaveFileRef.current();
      }
    });
  };

  return (
    <section className="tool-panel" aria-label="Files">
      <div className="tool-panel-header">
        <h2 className="panel-title">Files</h2>
        <div className="tool-panel-header-actions">
          <span className={`stream-status ${treeState}`}>tree {treeState}</span>
          <button
            className="icon-button"
            type="button"
            aria-label="Refresh file tree"
            title="Refresh file tree"
            disabled={treeState === "loading"}
            onClick={onRefreshTree}
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </div>
      <div className="file-grid">
        <div className="file-tree" role="tree">
          {treeState === "loading" ? (
            <div className="empty-state compact">Loading file tree...</div>
          ) : null}
          {treeState === "error" ? (
            <div className="empty-state compact">
              File tree could not be loaded.
            </div>
          ) : null}
          {treeState === "ready" && files.length === 0 ? (
            <div className="empty-state compact">
              No files returned for this session.
            </div>
          ) : null}
          <LazyFileTree
            nodes={files}
            selectedFilePath={selectedPath}
            pathStates={treePathStates}
            onSelectFile={onSelectFile}
            onLoadDirectory={onLoadDirectory}
            resetKey={treeId}
          />
        </div>
        <div
          className={`editor-placeholder ${fullscreen ? "is-fullscreen" : ""}`}
        >
          <div>
            <div className="editor-header">
              <div className="min-w-0">
                <p className="text-xs uppercase text-ink-500">Viewer</p>
                <h3>{selectedPath || "No file selected"}</h3>
              </div>
              <div className="editor-status" aria-label="File preview actions">
                {isMarkdown && !isEditing ? (
                  <div
                    className="file-view-toggle"
                    role="group"
                    aria-label="Markdown view"
                  >
                    <button
                      type="button"
                      className={markdownMode === "rendered" ? "is-active" : ""}
                      aria-pressed={markdownMode === "rendered"}
                      onClick={() => setMarkdownMode("rendered")}
                    >
                      <Eye size={13} />
                      Preview
                    </button>
                    <button
                      type="button"
                      className={markdownMode === "source" ? "is-active" : ""}
                      aria-pressed={markdownMode === "source"}
                      onClick={() => setMarkdownMode("source")}
                    >
                      <Code2 size={13} />
                      Source
                    </button>
                  </div>
                ) : null}
                {visibleContent && !isEditing ? (
                  <button
                    className="icon-button"
                    type="button"
                    aria-label="Refresh file preview"
                    title="Refresh file preview"
                    disabled={contentState === "loading"}
                    onClick={onRefreshFile}
                  >
                    <RefreshCw size={15} />
                  </button>
                ) : null}
                {visibleContent || fullscreen ? (
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={
                      fullscreen
                        ? "Exit fullscreen preview"
                        : "Fullscreen preview"
                    }
                    title={
                      fullscreen
                        ? "Exit fullscreen preview"
                        : "Fullscreen preview"
                    }
                    onClick={() => setFullscreen((current) => !current)}
                  >
                    {fullscreen ? (
                      <Minimize2 size={15} />
                    ) : (
                      <Maximize2 size={15} />
                    )}
                  </button>
                ) : null}
                {canEdit && !isEditing ? (
                  <button
                    className="small-button"
                    type="button"
                    onClick={onStartEdit}
                  >
                    <Pencil size={14} />
                    Edit
                  </button>
                ) : null}
                {isEditing ? (
                  <button
                    className="small-button"
                    type="button"
                    disabled={saveState === "loading"}
                    onClick={onCancelEdit}
                  >
                    <X size={14} />
                    Cancel
                  </button>
                ) : null}
                {isEditing ? (
                  <button
                    className="small-button"
                    type="button"
                    aria-label="Save file"
                    title="Save file"
                    disabled={!canSave}
                    onClick={onSaveFile}
                  >
                    <Save size={14} />
                    {saveState === "loading" ? "Saving" : "Save"}
                  </button>
                ) : null}
              </div>
            </div>
            {visibleContent ? (
              <>
                <p className="text-xs text-ink-500">
                  {visibleContent.encoding}
                  {"mimeType" in visibleContent
                    ? ` · ${visibleContent.mimeType}`
                    : ""}
                  {"size" in visibleContent
                    ? ` · ${formatBytes(visibleContent.size)}`
                    : ""}
                  {visibleContent.truncated ? " · truncated" : ""}
                </p>
                {showRenderedMarkdown ? (
                  <div className="file-markdown-preview">
                    <MarkdownMessage content={visibleTextContent.content} />
                  </div>
                ) : isTextContent(visibleContent) ? (
                  <Editor
                    className="monaco-file-editor"
                    height="100%"
                    language={languageForPath(visibleContent.path)}
                    path={editorModelPath(visibleContent.path)}
                    value={isEditing ? editorContent : visibleContent.content}
                    onChange={(value) => {
                      if (isEditing) {
                        onChangeContent(value ?? "");
                      }
                    }}
                    onMount={handleEditorMount}
                    wrapperProps={{
                      "aria-label": `${isEditing ? "File editor" : "File source preview"} for ${visibleContent.path}`,
                    }}
                    options={{
                      ariaLabel: isEditing
                        ? `Edit ${visibleContent.path}`
                        : `View source ${visibleContent.path}`,
                      readOnly: !isEditing || saveState === "loading",
                      minimap: { enabled: false },
                      automaticLayout: true,
                      scrollBeyondLastLine: false,
                      tabSize: 2,
                    }}
                  />
                ) : (
                  <FilePreview content={visibleContent} />
                )}
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

function FilePreview({
  content,
}: {
  content: Exclude<FileContentResult, { kind: "text" }>;
}) {
  if (content.kind === "image") {
    if (content.truncated || !content.contentBase64) {
      return (
        <div className="file-preview-empty">Image is too large to preview.</div>
      );
    }
    return (
      <div className="file-image-preview">
        <img
          src={`data:${content.mimeType};base64,${content.contentBase64}`}
          alt={`Preview ${content.path}`}
        />
      </div>
    );
  }
  return (
    <div className="file-preview-empty">Binary file cannot be previewed.</div>
  );
}

function isTextContent(
  content: FileContentResult,
): content is Extract<FileContentResult, { kind: "text" }> {
  const kind = (content as { kind?: string }).kind;
  return kind === undefined || kind === "text";
}

function contentMessage(
  selectedPath: string,
  contentState: FilePanelProps["contentState"],
) {
  if (!selectedPath) return "Select a file from the tree to load its contents.";
  if (contentState === "loading") return "Loading file content...";
  if (contentState === "error") return "File content could not be loaded.";
  return "Select a file from the tree to load its contents.";
}

function languageForPath(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  const languages: Record<string, string> = {
    css: "css",
    go: "go",
    html: "html",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "javascript",
    kt: "kotlin",
    md: "markdown",
    py: "python",
    rs: "rust",
    scss: "scss",
    sh: "shell",
    sql: "sql",
    ts: "typescript",
    tsx: "typescript",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
  };
  return languages[extension] ?? "plaintext";
}

function isMarkdownPath(path: string): boolean {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  return extension === "md" || extension === "markdown";
}

function editorModelPath(path: string): string {
  return `roam-file:///${path.split("/").map(encodeURIComponent).join("/")}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
