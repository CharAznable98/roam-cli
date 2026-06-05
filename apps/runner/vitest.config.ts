import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node"
  },
  resolve: {
    alias: {
      "@roamcli/protocol": fileURLToPath(new URL("../../packages/protocol/src/index.ts", import.meta.url)),
      "@roamcli/security": fileURLToPath(new URL("../../packages/security/src/index.ts", import.meta.url))
    }
  }
});
