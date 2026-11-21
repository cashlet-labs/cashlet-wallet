import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allServerUrls } from "../src/electrum/servers";

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
  it("lets the wallet reach every configured Electrum server, and nothing else", () => {
    const allowed = directive("connect-src").filter((source) => source !== "'self'");
    expect(allowed.sort()).toEqual(allServerUrls().sort());
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
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.externally_connectable).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
  });
});
