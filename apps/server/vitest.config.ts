import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 10000
  },
  resolve: {
    alias: {
      "@roamcli/shared/protocol": fileURLToPath(new URL("../../packages/shared/src/protocol/index.ts", import.meta.url)),
      "@roamcli/shared/security": fileURLToPath(new URL("../../packages/shared/src/security/index.ts", import.meta.url))
    }
  }
});
