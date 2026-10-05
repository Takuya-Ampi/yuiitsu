import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // テストでは、ビルド済みの dist ではなくソースを参照する
    alias: {
      "@yuiitsu/core": src("core"),
      "@yuiitsu/dialect-postgres": src("dialect-postgres"),
      "@yuiitsu/dialect-mysql": src("dialect-mysql"),
      "@yuiitsu/dialect-sqlite": src("dialect-sqlite"),
    },
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  test: {
    include: ["packages/*/test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
    globalSetup: ["./packages/contract-tests/test/global-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
  run: {
    tasks: {
      "db:up": { command: "docker compose up -d --wait", cache: false },
      "db:down": { command: "docker compose down", cache: false },
      "db:reset": {
        command: "docker compose down -v && docker compose up -d --wait",
        cache: false,
      },
    },
  },
});
