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
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === "/v1" || pathname.startsWith("/v1/")) {
      return reply.code(404).send({ error: "not_found" });
    }
    if (request.method !== "GET" || path.extname(pathname)) {
      return reply.code(404).send({ error: "not_found" });
    }
    const indexPath = path.join(webDistDir, "index.html");
    if (fs.existsSync(indexPath)) {
      return reply.type("text/html").send(fs.createReadStream(indexPath));
    }
    return reply.code(404).send({ error: "not_found" });
  });
}
