import { access } from "node:fs/promises";
import { EventCache } from "../../persistence/cache.js";

const [cachePath, barrierPath, writer, countText] = process.argv.slice(2);
if (
  cachePath === undefined ||
  barrierPath === undefined ||
  writer === undefined ||
  countText === undefined
) {
  throw new Error("Missing event cache child writer arguments");
}

const count = Number.parseInt(countText, 10);
if (!Number.isSafeInteger(count) || count <= 0) {
  throw new Error("Invalid event cache child writer count");
}

while (true) {
  try {
    await access(barrierPath);
    break;
  } catch {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

const cache = new EventCache(cachePath);
await Promise.all(
  Array.from({ length: count }, (_, index) =>
    cache.append({
      type: "sessionStatus",
      sessionId: `${writer}-${index}`,
      status: "running",
    }),
  ),
);
