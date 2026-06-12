import type { FastifyInstance } from "fastify";
import { RunnerEventSchema, type RunnerRegistration } from "@roamcli/shared/protocol";
import { isAuthorized } from "../auth.js";
import { parseSocketJson } from "../infra/socket-json.js";
import { parseRunnerRegistration } from "../modules/runners/runner-registration.js";
import type { AppContext } from "../server/context.js";

export function registerRunnerSocketRoute(
  app: FastifyInstance,
  context: AppContext,
  authToken: string | undefined,
): void {
  app.get("/v1/runner", { websocket: true }, (socket, request) => {
    if (!isAuthorized(authToken, request)) {
      socket.close(1008, "unauthorized");
      return;
    }

    let registeredRunner: RunnerRegistration | undefined;

    socket.on("message", (data) => {
      try {
        const payload = parseSocketJson(data);
        if (!registeredRunner) {
          registeredRunner = parseRunnerRegistration(payload);
          context.hub.registerRunner(registeredRunner, socket);
          return;
        }

        const event = RunnerEventSchema.parse(payload);
        context.services.runnerEvents.handle(event);
      } catch (error) {
        context.hub.sendError(
          socket,
          error instanceof Error ? error.message : "invalid runner event",
          "invalid_runner_event",
        );
      }
    });
  });
}
