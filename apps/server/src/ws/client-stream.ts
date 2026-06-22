import type { FastifyInstance, FastifyRequest } from "fastify";
import { ClientCommandSchema } from "@roamcli/shared/protocol";
import { parseSocketJson } from "../infra/socket-json.js";
import type { AppContext } from "../server/context.js";

export function registerClientStreamRoute(
  app: FastifyInstance,
  context: AppContext,
  publicOrigin?: string,
): void {
  app.get("/v1/stream", { websocket: true }, (socket, request) => {
    if (!isStreamOriginAllowed(request, publicOrigin)) {
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

function isStreamOriginAllowed(
  request: FastifyRequest,
  publicOrigin: string | undefined,
): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin.length === 0) {
    return false;
  }
  if (publicOrigin) {
    return normalizeOrigin(origin) === normalizeOrigin(publicOrigin);
  }
  const host = firstHeaderValue(
    request.headers["x-forwarded-host"] ?? request.headers.host,
  );
  if (!host) {
    return false;
  }
  const proto =
    firstHeaderValue(request.headers["x-forwarded-proto"]) ?? request.protocol;
  return normalizeOrigin(origin) === `${proto}://${host}`;
}

function normalizeOrigin(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${url.host}`;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value?.split(",")[0]?.trim();
}
