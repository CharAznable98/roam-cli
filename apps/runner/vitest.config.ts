import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node"
  },
  resolve: {
    alias: {
      "@roamcli/protocol": fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url)),
      "@roamcli/agent-codex": fileURLToPath(new URL("../../packages/agent-codex/src/index.ts", import.meta.url)),
      "@roamcli/agent-plugin-sdk": fileURLToPath(new URL("../../packages/agent-plugin-sdk/src/index.ts", import.meta.url)),
      "@roamcli/security": fileURLToPath(new URL("../../packages/security/src/index.ts", import.meta.url))
    }
  }
});
