import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    globals: false,
    // Native Windows ACL operations start system utilities; concurrent fixtures need more time.
    testTimeout: process.platform === "win32" ? 15_000 : 5_000,
    poolOptions: {
      forks: {
        // Let jsdom provide Web Storage instead of Node 25+ native storage.
        execArgv: process.allowedNodeEnvironmentFlags.has(
          "--no-experimental-webstorage",
        )
          ? ["--no-experimental-webstorage"]
          : [],
      },
    },
  },
  resolve: {
    alias: {
      "@": `${root}apps/web/src`,
      "@roamcli/shared/protocol": `${root}packages/shared/src/protocol/index.ts`,
      "@roamcli/agent-codex": `${root}packages/agent-codex/src/index.ts`,
      "@roamcli/agent-pi": `${root}packages/agent-pi/src/index.ts`,
      "@roamcli/agent-claude-code": `${root}packages/agent-claude-code/src/index.ts`,
      "@roamcli/agent-plugin-sdk": `${root}packages/agent-plugin-sdk/src/index.ts`,
      "@roamcli/shared/security": `${root}packages/shared/src/security/index.ts`,
    },
  },
});
