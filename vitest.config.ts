import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    maxWorkers: 2,
    restoreMocks: true,
    server: {
      deps: {
        external: [/\/node_modules\/(?:\.pnpm\/)?@oh-my-pi(?:[+/]|\/)/],
      },
    },
  },
});