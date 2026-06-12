import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 10000
  },
  resolve: {
    alias: {
      "@roamcli/shared/protocol": new URL("../../packages/shared/src/protocol/index.ts", import.meta.url).pathname,
      "@roamcli/shared/security": new URL("../../packages/shared/src/security/index.ts", import.meta.url).pathname
    }
  }
});
