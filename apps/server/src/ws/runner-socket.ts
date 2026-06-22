import type { FastifyInstance } from "fastify";
import type { RawData } from "ws";
import { z } from "zod";
import {
  RunnerEventSchema,
  RunnerRegistrationSchema,
  type RunnerRegistration,
} from "@roamcli/shared/protocol";
import { parseSocketJson } from "../infra/socket-json.js";
import type { AppContext } from "../server/context.js";

const MAX_RUNNER_AUTH_MESSAGE_BYTES = 64 * 1024;
const RunnerAuthEnvelopeSchema = z.object({
  type: z.literal("runnerAuthenticate"),
  token: z.string().min(1),
  runner: z.unknown(),
});

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
        if (!registeredRunner) {
          if (socketDataByteLength(data) > MAX_RUNNER_AUTH_MESSAGE_BYTES) {
            socket.close(1009, "runner authentication payload too large");
            return;
          }
          const envelope = RunnerAuthEnvelopeSchema.safeParse(
            parseSocketJson(data),
          );
          if (!envelope.success) {
            socket.close(1008, "invalid runner authentication");
            return;
          }
          const auth = envelope.data;
          if (
            !context.services.auth.authenticateRunnerToken(
              auth.token,
              runnerIdForLog(auth.runner),
            )
          ) {
            socket.close(1008, "unauthorized");
            return;
          }
          const runner = RunnerRegistrationSchema.safeParse(auth.runner);
          if (!runner.success) {
            socket.close(1008, "invalid runner registration");
            return;
          }
          registeredRunner = runner.data;
          clearTimeout(authTimer);
          context.hub.registerRunner(registeredRunner, socket);
          return;
        }

        const payload = parseSocketJson(data);
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

function socketDataByteLength(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}

function runnerIdForLog(runner: unknown): string {
  if (!runner || typeof runner !== "object" || Array.isArray(runner)) {
    return "unknown";
  }
  const runnerId = (runner as { runnerId?: unknown }).runnerId;
  return typeof runnerId === "string" && runnerId.length > 0
    ? runnerId.slice(0, 120)
    : "unknown";
}
