import fs from "node:fs";
import path from "node:path";
import staticPlugin from "@fastify/static";
import type { FastifyInstance } from "fastify";

export async function registerWebDist(
  app: FastifyInstance,
  webDistDir: string,
): Promise<void> {
  await app.register(staticPlugin, {
    root: webDistDir,
    prefix: "/",
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/v1/")) {
      return reply.code(404).send({ error: "not_found" });
    }
    const indexPath = path.join(webDistDir, "index.html");
    if (fs.existsSync(indexPath)) {
      return reply.type("text/html").send(fs.createReadStream(indexPath));
    }
    return reply.code(404).send({ error: "not_found" });
  });
}
