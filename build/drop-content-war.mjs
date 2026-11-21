// crxjs lists every content script as a web-accessible resource, for its
// development loader. The built scripts are self-contained and Chrome injects
// them from the manifest, so the entry is not needed. Left in, it would let
// any site detect the extension by fetching chrome-extension://<id>/assets/….
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function dropContentScriptResources() {
  let outDir = "dist";
  return {
    name: "drop-content-script-resources",
    apply: "build",
    enforce: "post",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    writeBundle() {
      const path = join(outDir, "manifest.json");
      const manifest = JSON.parse(readFileSync(path, "utf8"));
      const scripts = new Set((manifest.content_scripts ?? []).flatMap((c) => c.js ?? []));
      const kept = (manifest.web_accessible_resources ?? [])
        .map((entry) => ({ ...entry, resources: entry.resources.filter((r) => !scripts.has(r)) }))
        .filter((entry) => entry.resources.length > 0);
      if (kept.length > 0) manifest.web_accessible_resources = kept;
      else delete manifest.web_accessible_resources;
      writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    },
  };
}
