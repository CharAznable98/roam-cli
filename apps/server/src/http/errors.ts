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
    return reply.code(runnerErrorStatusCode(error.runnerCode)).send({
      error: "runner_error",
      ...(error.runnerCode ? { code: error.runnerCode } : {}),
      message: error.message,
    });
  }
  throw error;
}

function runnerErrorStatusCode(runnerCode: string | undefined): number {
  switch (runnerCode) {
    case "INVALID_CWD":
    case "DIRECTORY_CREATE_ERROR":
    case "FILE_TREE_ERROR":
      return 400;
    case "SESSION_NOT_FOUND":
      return 409;
    default:
      return 502;
  }
}
