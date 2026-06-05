import { createServer } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await createServer(config);

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`roamcli server listening on http://${config.host}:${config.port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

export { createServer };
