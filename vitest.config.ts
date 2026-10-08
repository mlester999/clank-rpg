import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/support/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    restoreMocks: true,
    // Integration files each run an in-process Postgres (PGlite: WASM, CPU-bound). One worker per core left nothing for the OS, the browser and
    // the editor, and under load a 6 s Arena test stretched past 60 s (measured: the two "flaky" Arena timeouts were 10× CPU oversubscription,
    // not slow code). Half the cores keeps every file well inside its timeout without raising any timeout.
    maxWorkers: "50%",
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
