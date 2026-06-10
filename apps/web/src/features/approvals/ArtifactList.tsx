import type { Artifact } from "@roamcli/protocol";

export function ArtifactList({ artifacts }: { artifacts: Artifact[] }) {
  return (
    <section className="tool-panel" aria-label="Artifacts">
      <div className="tool-panel-header">
        <h2 className="panel-title">Artifacts</h2>
        <span className="text-xs text-ink-500">{artifacts.length}</span>
      </div>
      {artifacts.length === 0 ? (
        <div className="empty-state compact">
          No artifacts uploaded for this session.
        </div>
      ) : null}
      {artifacts.map((artifact) => (
        <article key={artifact.id} className="approval-card">
          <h3 className="truncate font-medium text-ink-900">{artifact.name}</h3>
          <p className="mt-1 text-xs text-ink-500">
            {artifact.kind} · {artifact.mimeType} · {artifact.size} bytes
          </p>
          {artifact.kind === "patch" ? (
            <pre aria-label={`${artifact.name} metadata`}>
              {JSON.stringify(
                {
                  id: artifact.id,
                  sha256: artifact.sha256,
                  storagePath: artifact.storagePath,
                  createdAt: artifact.createdAt,
                },
                null,
                2,
              )}
            </pre>
          ) : null}
        </article>
      ))}
    </section>
  );
}
