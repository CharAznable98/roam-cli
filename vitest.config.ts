import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    globals: false
  },
  resolve: {
    alias: {
      "@roamcli/protocol": `${root}packages/protocol/src/index.ts`,
      "@roamcli/parser-sdk": `${root}packages/parser-sdk/src/index.ts`,
      "@roamcli/security": `${root}packages/security/src/index.ts`
    }
  }
});
