#!/usr/bin/env node
import { createRunner } from "./bootstrap/create-runner.js";

async function main(): Promise<void> {
  const runner = await createRunner(process.argv.slice(2));
  await runner.start();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`roam-runner: ${message}`);
  process.exitCode = 1;
});
