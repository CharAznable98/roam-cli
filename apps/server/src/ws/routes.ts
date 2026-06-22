import type { FastifyInstance } from "fastify";
import type { AppContext } from "../server/context.js";
import { registerClientStreamRoute } from "./client-stream.js";
import { registerRunnerSocketRoute } from "./runner-socket.js";

export function registerWebSocketRoutes(
  app: FastifyInstance,
  context: AppContext,
  publicOrigin?: string,
): void {
  registerClientStreamRoute(app, context, publicOrigin);
  registerRunnerSocketRoute(app, context);
}
