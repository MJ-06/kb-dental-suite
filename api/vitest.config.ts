import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The files share one test database, which each one resets.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000
  }
});
