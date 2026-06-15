import type { FastifyReply } from "fastify";
import { RunnerRpcError } from "../infra/runner-rpc-client.js";

export function sendRunnerRpcError(reply: FastifyReply, error: unknown) {
  if (error instanceof RunnerRpcError && error.code === "runner_offline") {
    return reply.code(409).send({ error: "runner_offline" });
  }
  if (error instanceof RunnerRpcError && error.code === "runner_timeout") {
    return reply.code(504).send({ error: "runner_timeout" });
  }
  if (error instanceof RunnerRpcError && error.code === "runner_error") {
    const statusCode =
      error.runnerCode === "INVALID_CWD"
        ? 400
        : error.runnerCode === "SESSION_NOT_FOUND"
          ? 409
          : 502;
    return reply.code(statusCode).send({
      error: "runner_error",
      ...(error.runnerCode ? { code: error.runnerCode } : {}),
      message: error.message,
    });
  }
  throw error;
}
