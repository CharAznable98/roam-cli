import type { FastifyInstance } from "fastify";
import type { AppContext } from "../server/context.js";
import { registerClientStreamRoute } from "./client-stream.js";
import { registerRunnerSocketRoute } from "./runner-socket.js";

export function registerWebSocketRoutes(
  app: FastifyInstance,
  context: AppContext,
  authToken: string | undefined,
): void {
  registerClientStreamRoute(app, context, authToken);
  registerRunnerSocketRoute(app, context, authToken);
}
