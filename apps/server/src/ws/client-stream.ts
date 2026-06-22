import type { FastifyInstance } from "fastify";
import { ClientCommandSchema } from "@roamcli/shared/protocol";
import { isRequestOriginAllowed } from "../infra/http-security.js";
import { parseSocketJson } from "../infra/socket-json.js";
import type { AppContext } from "../server/context.js";

export function registerClientStreamRoute(
  app: FastifyInstance,
  context: AppContext,
  publicOrigin?: string,
): void {
  app.get("/v1/stream", { websocket: true }, (socket, request) => {
    if (!isRequestOriginAllowed(request, publicOrigin)) {
      socket.close(1008, "invalid origin");
      return;
    }
    const session = context.services.auth.authenticateRequest(request);
    if (!session) {
      socket.close(1008, "unauthorized");
      return;
    }
    context.hub.addStream(
      socket,
      session.record.id,
      () =>
        context.services.auth.authenticateSessionId(session.record.id) !==
        undefined,
    );
    socket.on("message", (data) => {
      const activeSession = context.services.auth.authenticateSessionId(
        session.record.id,
        { touch: true },
      );
      if (!activeSession) {
        socket.close(1008, "session expired");
        return;
      }
      try {
        const command = ClientCommandSchema.parse(parseSocketJson(data));
        void context.services.sessions
          .handleClientCommand(command, activeSession.id)
          .catch((error: unknown) => {
            context.hub.sendError(
              socket,
              error instanceof Error ? error.message : "command failed",
              "command_failed",
            );
          });
      } catch (error) {
        context.hub.sendError(
          socket,
          error instanceof Error ? error.message : "invalid command",
          "invalid_command",
        );
      }
    });
  });
}
