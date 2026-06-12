import type { Artifact } from "@roamcli/shared/protocol";
import type {
  ArtifactStorage,
  CreateArtifactRequest,
} from "../../infra/local-artifact-storage.js";
import type { ConnectionHub } from "../../infra/connection-hub.js";
import type { ServerStore } from "../../infra/sqlite-store.js";
import { fail, ok, type ServiceResult } from "../result.js";

export class ArtifactService {
  constructor(
    private readonly store: ServerStore,
    private readonly artifacts: ArtifactStorage,
    private readonly hub: ConnectionHub,
  ) {}

  createArtifact(
    request: CreateArtifactRequest,
  ): ServiceResult<{ artifact: Artifact }> {
    if (!this.store.getSession(request.sessionId)) {
      return fail("session_not_found");
    }

    const artifact = this.artifacts.write(request);
    try {
      this.store.addArtifact(artifact);
    } catch (error) {
      try {
        this.artifacts.deleteArtifact(artifact);
      } catch {
        // Best-effort cleanup; preserve original persistence error.
      }
      throw error;
    }
    this.hub.broadcast({ type: "artifact:created", artifact });
    return ok({ artifact });
  }

  deleteSessionArtifacts(sessionId: string): void {
    this.artifacts.deleteSessionArtifacts(sessionId);
  }
}
