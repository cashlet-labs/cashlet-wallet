import { crx } from "@crxjs/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { libauthSyncCrypto } from "./build/libauth-sync-crypto.mjs";
import manifest from "./manifest.json" with { type: "json" };

export default defineConfig({
  plugins: [libauthSyncCrypto(), react(), crx({ manifest })],
  build: {
    target: "es2022",
    // Release builds ship no source maps: they would publish the wallet's source in the package.
    sourcemap: false,
    modulePreload: { polyfill: false },
  },
});
