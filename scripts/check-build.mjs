// Checks the built extension in dist/ before it can be packaged:
//
// 1. The manifest is there and names a service worker.
// 2. No source maps ship: they would publish the wallet's source.
// 3. Nothing the service worker loads uses top-level await. Chrome refuses to
//    start an MV3 service worker whose module graph contains it.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const dist = resolve(import.meta.dirname, "..", "dist");
const problems = [];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

if (!existsSync(join(dist, "manifest.json"))) {
  console.error("dist/manifest.json is missing: run vite build first.");
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
const worker = manifest.background?.service_worker;
if (typeof worker !== "string") problems.push("the manifest names no service worker");

for (const file of walk(dist)) {
  if (file.endsWith(".map")) problems.push(`source map in the package: ${relative(dist, file)}`);
  if (readFileSync(file).includes("sourceMappingURL=")) {
    if (/\.(js|css)$/.test(file)) problems.push(`source map reference: ${relative(dist, file)}`);
  }
}

/** Static imports of a module, and whether it has await outside any function. */
function inspect(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const imports = [];
  let topLevelAwait = false;
  const visit = (node, inFunction) => {
    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    }
    if (
      !inFunction &&
      (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier))
    ) {
      topLevelAwait = true;
    }
    const nested = inFunction || ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node);
    ts.forEachChild(node, (child) => visit(child, nested));
  };
  visit(source, false);
  return { imports, topLevelAwait };
}

if (typeof worker === "string") {
  const seen = new Set();
  const queue = [resolve(dist, worker)];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!existsSync(file)) {
      problems.push(`the service worker imports a missing file: ${relative(dist, file)}`);
      continue;
    }
    const { imports, topLevelAwait } = inspect(file);
    if (topLevelAwait)
      problems.push(`top-level await in the service worker graph: ${relative(dist, file)}`);
    for (const specifier of imports) {
      if (specifier.startsWith(".") || specifier.startsWith("/")) {
        queue.push(
          specifier.startsWith("/") ? join(dist, specifier) : resolve(dirname(file), specifier),
        );
      } else {
        problems.push(
          `unbundled import in the service worker: ${specifier} (${relative(dist, file)})`,
        );
      }
    }
  }
  console.log(`Service worker graph: ${seen.size} files checked.`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`);
  process.exit(1);
}
console.log(
  "Build checks passed: manifest, no source maps, no top-level await in the service worker.",
);
