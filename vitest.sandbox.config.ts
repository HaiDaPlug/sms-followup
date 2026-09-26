import path from "node:path";
import { defineConfig } from "vitest/config";

// Integration runner for the local Supabase sandbox (docs/sandbox.md). Kept
// separate from vitest.config.ts so "npm test" never needs Docker: the default
// runner only collects *.test.ts, and these files are *.sandbox.ts.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Next.js supplies "server-only" at build time; it is not an npm
      // dependency here, and the real module throws outside a server bundle.
      "server-only": path.resolve(__dirname, "./src/test/sandbox/serverOnlyStub.ts")
    }
  },
  test: {
    environment: "node",
    include: ["src/test/sandbox/**/*.sandbox.ts"],
    setupFiles: ["./src/test/sandbox/setup.ts"],
    // Every file shares one database and each test starts with sandbox_reset(),
    // so two files running at once would wipe each other's state mid-test.
    fileParallelism: false,
    // Room for a real run plus steerClearOfVisitBoundary's wait of up to 61 s.
    testTimeout: 180_000,
    hookTimeout: 180_000
  }
});
