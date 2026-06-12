import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    globals: false
  },
  resolve: {
    alias: {
      "@roamcli/shared/protocol": `${root}packages/shared/src/protocol/index.ts`,
      "@roamcli/agent-codex": `${root}packages/agent-codex/src/index.ts`,
      "@roamcli/agent-plugin-sdk": `${root}packages/agent-plugin-sdk/src/index.ts`,
      "@roamcli/shared/security": `${root}packages/shared/src/security/index.ts`
    }
  }
});
