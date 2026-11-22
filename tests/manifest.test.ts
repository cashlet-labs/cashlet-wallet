import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allServerUrls } from "../src/electrum/servers";
import { WIZARD_RELAY } from "../src/background/wizard";
import { BCMR_GATEWAY } from "../src/wallet/bcmr";
import { allRelayUrls } from "../src/wallet/identity";
import { RATE_ORIGINS } from "../src/wallet/rates";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8")) as {
  permissions: string[];
  content_security_policy: { extension_pages: string };
  host_permissions?: string[];
  content_scripts?: unknown[];
  externally_connectable?: unknown;
  web_accessible_resources?: unknown;
};

function directive(name: string): string[] {
  const policy = manifest.content_security_policy.extension_pages;
  const part = policy
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${name} `));
  return part ? part.split(/\s+/).slice(1) : [];
}

describe("manifest.json", () => {
  it("lets the wallet reach every configured Electrum server, Nostr relay and the one registry gateway, rate sources, and nothing else", () => {
    const allowed = directive("connect-src").filter((source) => source !== "'self'");
    expect(allowed.sort()).toEqual(
      [...allServerUrls(), ...allRelayUrls(), WIZARD_RELAY, BCMR_GATEWAY, ...RATE_ORIGINS].sort(),
    );
  });

  it("keeps a strict policy for extension pages", () => {
    expect(directive("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(directive("object-src")).toEqual(["'none'"]);
    // No remote images: a dApp-supplied icon would leak the user's address and timing.
    expect(directive("img-src")).toEqual(["'self'", "data:"]);
  });

  it("asks only for the permissions it uses, and exposes nothing to web pages", () => {
    expect(manifest.permissions.sort()).toEqual(["alarms", "sidePanel", "storage"]);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.externally_connectable).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
  });

  it("injects the page API on https pages and local development pages only, top frame only", () => {
    const pages = ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"];
    expect(manifest.content_scripts).toEqual([
      { matches: pages, js: ["src/content/inpage.ts"], run_at: "document_start", world: "MAIN" },
      { matches: pages, js: ["src/content/bridge.ts"], run_at: "document_start" },
    ]);
  });
});
