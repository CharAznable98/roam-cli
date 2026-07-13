import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";
import { z } from "zod";
import {
  RunnerAuthenticateSchema,
  RunnerEventEnvelopeSchema,
  RunnerEventSchema,
  type RunnerRegistration,
} from "@roamcli/shared/protocol";
import { parseSocketJson } from "../infra/socket-json.js";
import type { AppContext } from "../server/context.js";

const MAX_RUNNER_AUTH_MESSAGE_BYTES = 64 * 1024;
const RunnerAuthEnvelopeSchema = z.object({
  type: z.literal("runnerAuthenticate"),
  token: z.string().min(1),
  runner: z.unknown(),
  eventDelivery: z.unknown().optional(),
});

interface NegotiatedEventStream {
  streamId: string;
}

export function registerRunnerSocketRoute(
  app: FastifyInstance,
  context: AppContext,
): void {
  app.get("/v1/runner", { websocket: true }, (socket, request) => {
    let registeredRunner: RunnerRegistration | undefined;
    let eventStream: NegotiatedEventStream | undefined;
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
          const authEnvelope = envelope.data;
          if (
            !context.services.auth.authenticateRunnerToken(
              authEnvelope.token,
              runnerIdForLog(authEnvelope.runner),
            )
          ) {
            socket.close(1008, "unauthorized");
            return;
          }
          const authentication =
            RunnerAuthenticateSchema.safeParse(authEnvelope);
          if (!authentication.success) {
            socket.close(1008, "invalid runner registration");
            return;
          }
          const { runner, eventDelivery } = authentication.data;
          if (eventDelivery) {
            const negotiation = context.store.negotiateRunnerEventStream(
              runner.runnerId,
              eventDelivery.streamId,
              eventDelivery.acknowledgedThrough,
            );
            if (!negotiation.ok) {
              clearTimeout(authTimer);
              socket.close(1008, "runner event stream mismatch");
              return;
            }
            if (
              !sendRunnerControl(socket, {
                type: "runnerEventResume",
                protocol: "ack_v1",
                streamId: eventDelivery.streamId,
                ackThrough: negotiation.ackThrough,
              })
            ) {
              clearTimeout(authTimer);
              socket.close(1011, "runner event negotiation failed");
              return;
            }
            eventStream = { streamId: eventDelivery.streamId };
          }
          registeredRunner = runner;
          clearTimeout(authTimer);
          context.hub.registerRunner(registeredRunner, socket);
          void context.services.sessions.reconcilePendingInputDeliveries(
            registeredRunner.runnerId,
          );
          void context.services.sessions.reconcileAttachmentCleanupJobs(
            registeredRunner.runnerId,
          );
          return;
        }

        const payload = parseSocketJson(data);
        if (eventStream) {
          const envelope = RunnerEventEnvelopeSchema.safeParse(payload);
          if (!envelope.success) {
            socket.close(1008, "runner event envelope required");
            return;
          }
          if (envelope.data.streamId !== eventStream.streamId) {
            socket.close(1008, "runner event stream mismatch");
            return;
          }
          let result: ReturnType<typeof context.store.processRunnerEvent>;
          let afterCommit: (() => void) | undefined;
          try {
            result = context.store.processRunnerEvent(
              registeredRunner.runnerId,
              eventStream.streamId,
              envelope.data.sequence,
              () => {
                afterCommit = context.services.runnerEvents.handle(
                  envelope.data.event,
                  true,
                );
              },
            );
          } catch (error) {
            request.log.error(
              { err: error, runnerId: registeredRunner.runnerId },
              "runner event transaction failed",
            );
            socket.close(1011, "runner event handler failed");
            return;
          }
          if (result.status === "stream_mismatch") {
            socket.close(1008, "runner event stream mismatch");
            return;
          }
          if (result.status === "gap") {
            if (
              !sendRunnerControl(socket, {
                type: "runnerEventNack",
                protocol: "ack_v1",
                streamId: eventStream.streamId,
                ackThrough: result.ackThrough,
                expectedSequence: result.expectedSequence,
              })
            ) {
              socket.close(1011, "runner event response failed");
            }
            return;
          }
          if (result.status === "committed") {
            afterCommit?.();
          } else if (result.status === "duplicate") {
            context.services.runnerEvents.reconcileCommittedEffects();
          }
          if (
            !sendRunnerControl(socket, {
              type: "runnerEventAck",
              protocol: "ack_v1",
              streamId: eventStream.streamId,
              ackThrough: result.ackThrough,
            })
          ) {
            socket.close(1011, "runner event response failed");
          }
          return;
        }
        if (isRunnerEventEnvelopeLike(payload)) {
          socket.close(1008, "runner event delivery not negotiated");
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
        if (eventStream) {
          socket.close(1008, "invalid runner event envelope");
        }
      }
    });
  });
}

function sendRunnerControl(socket: WebSocket, payload: unknown): boolean {
  if (socket.readyState !== socket.OPEN) {
    return false;
  }
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
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

function isRunnerEventEnvelopeLike(
  value: unknown,
): value is { type: "runnerEvent" } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "type" in value &&
    value.type === "runnerEvent"
  );
}
