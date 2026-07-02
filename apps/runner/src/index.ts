#!/usr/bin/env node
import { resolveRunnerConfigDraft } from "./bootstrap/cli.js";
import { createRunner } from "./bootstrap/create-runner.js";
import {
  hasAlreadyReexeced,
  isPluginLoadFailure,
  reexecRunnerWithNpx,
} from "./bootstrap/npx-reexec.js";
import { maybeRunRunnerWizard } from "./bootstrap/wizard.js";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  await maybeRunRunnerWizard(argv);
  let runner;
  try {
    runner = await createRunner(argv);
  } catch (error) {
    if (isPluginLoadFailure(error) && !hasAlreadyReexeced()) {
      const { options } = await resolveRunnerConfigDraft(argv);
      if (options.agentPlugins.length > 0) {
        await reexecRunnerWithNpx({
          agentPlugins: options.agentPlugins,
          runnerArgs: argv,
        });
      }
    }
    throw error;
  }
  await runner.start();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`roam-runner: ${message}`);
  process.exitCode = 1;
});
