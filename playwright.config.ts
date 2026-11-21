import { defineConfig } from "@playwright/test";

// Runs against the built extension in dist/: run `npm run build` first.
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // Each test starts its own browser with the extension loaded.
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
});
