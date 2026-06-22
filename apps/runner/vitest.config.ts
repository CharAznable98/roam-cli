import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node"
  },
  resolve: {
    alias: {
      "@roamcli/agent-claude-code": fileURLToPath(new URL("../../packages/agent-claude-code/src/index.ts", import.meta.url)),
      "@roamcli/shared/protocol": fileURLToPath(new URL("../../packages/shared/src/protocol/index.ts", import.meta.url)),
      "@roamcli/agent-codex": fileURLToPath(new URL("../../packages/agent-codex/src/index.ts", import.meta.url)),
      "@roamcli/agent-plugin-sdk": fileURLToPath(new URL("../../packages/agent-plugin-sdk/src/index.ts", import.meta.url)),
      "@roamcli/shared/security": fileURLToPath(new URL("../../packages/shared/src/security/index.ts", import.meta.url))
    }
  }
});
