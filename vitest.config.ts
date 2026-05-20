import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    // Route handlers read PROVIDER_WEBHOOK_SECRET at module load, so we set
    // env in the setup file before any imports happen.
    setupFiles: ["./vitest.setup.ts"],
  },
});
