import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(directory, "migrations")),
          BOOTSTRAP_TOKEN: "bootstrap-token-with-at-least-32-characters",
          IP_HASH_SECRET: "test-ip-hash-secret-with-at-least-32-chars"
        }
      }
    }))
  ],
  test: {
    setupFiles: ["./tests/apply-migrations.js"],
    sequence: { concurrent: false }
  }
});
