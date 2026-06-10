import type { FastifyReply, FastifyRequest } from "fastify";

export function isAuthorized(
  token: string | undefined,
  request: FastifyRequest,
): boolean {
  if (!token) {
    return true;
  }

  const authorization = request.headers.authorization;
  if (authorization === `Bearer ${token}`) {
    return true;
  }

  const headerToken = request.headers["x-roamcli-token"];
  if (headerToken === token) {
    return true;
  }

  const query = request.query as { token?: string } | undefined;
  return query?.token === token;
}

export async function requireAuth(
  token: string | undefined,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (isAuthorized(token, request)) {
    return;
  }

  await reply.code(401).send({ error: "unauthorized" });
}
