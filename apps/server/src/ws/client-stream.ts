import type { FastifyInstance } from "fastify";
import { ClientCommandSchema } from "@roamcli/protocol";
import { isAuthorized } from "../auth.js";
import { parseSocketJson } from "../infra/socket-json.js";
import type { AppContext } from "../server/context.js";

export function registerClientStreamRoute(
  app: FastifyInstance,
  context: AppContext,
  authToken: string | undefined,
): void {
  app.get("/v1/stream", { websocket: true }, (socket, request) => {
    if (!isAuthorized(authToken, request)) {
      socket.close(1008, "unauthorized");
      return;
    }
    context.hub.addStream(socket);
    socket.on("message", (data) => {
      try {
        const command = ClientCommandSchema.parse(parseSocketJson(data));
        context.services.sessions.handleClientCommand(command);
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
