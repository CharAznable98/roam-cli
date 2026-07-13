import { access } from "node:fs/promises";
import { AuditLog } from "../../persistence/audit.js";

const [auditPath, barrierPath, writer, countText] = process.argv.slice(2);
if (
  auditPath === undefined ||
  barrierPath === undefined ||
  writer === undefined ||
  countText === undefined
) {
  throw new Error("Missing audit child writer arguments");
}

const count = Number.parseInt(countText, 10);
if (!Number.isSafeInteger(count) || count <= 0) {
  throw new Error("Invalid audit child writer count");
}

while (true) {
  try {
    await access(barrierPath);
    break;
  } catch {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2);
    });
  }
}

const audit = new AuditLog(auditPath);
await Promise.all(
  Array.from({ length: count }, (_, index) =>
    audit.append("child_event", { writer, index }),
  ),
);
