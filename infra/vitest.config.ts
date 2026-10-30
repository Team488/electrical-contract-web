import { defineConfig } from "vitest/config";

// Each test synthesizes the stack (including the esbuild bundle), which takes a few seconds.
export default defineConfig({ test: { testTimeout: 60000 } });
