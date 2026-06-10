import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 10000
  },
  resolve: {
    alias: {
      "@roamcli/protocol": new URL("../../packages/protocol/src/index.ts", import.meta.url).pathname,
      "@roamcli/security": new URL("../../packages/security/src/index.ts", import.meta.url).pathname
    }
  }
});
