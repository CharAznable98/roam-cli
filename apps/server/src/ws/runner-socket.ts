import type { FastifyInstance } from "fastify";
import {
  RunnerAuthenticateSchema,
  RunnerEventSchema,
  type RunnerRegistration,
} from "@roamcli/shared/protocol";
import { parseSocketJson } from "../infra/socket-json.js";
import type { AppContext } from "../server/context.js";

export function registerRunnerSocketRoute(
  app: FastifyInstance,
  context: AppContext,
): void {
  app.get("/v1/runner", { websocket: true }, (socket, request) => {
    let registeredRunner: RunnerRegistration | undefined;
    const authTimer = setTimeout(() => {
      if (!registeredRunner) {
        socket.close(1008, "runner authentication timeout");
      }
    }, 5000);

    socket.on("message", (data) => {
      try {
        const payload = parseSocketJson(data);
        if (!registeredRunner) {
          const auth = RunnerAuthenticateSchema.parse(payload);
          if (
            !context.services.auth.authenticateRunnerToken(
              auth.token,
              auth.runner.runnerId,
            )
          ) {
            socket.close(1008, "unauthorized");
            return;
          }
          registeredRunner = auth.runner;
          clearTimeout(authTimer);
          context.hub.registerRunner(registeredRunner, socket);
          return;
        }

        const event = RunnerEventSchema.parse(payload);
        context.services.runnerEvents.handle(event);
      } catch (error) {
        request.log.warn(
          { err: error },
          registeredRunner
            ? "ignored invalid runner event"
            : "ignored invalid runner registration",
        );
      }
    });
  });
}
