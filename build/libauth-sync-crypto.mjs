// Replaces @bitauth/libauth's async WebAssembly crypto bootstrap with a
// synchronous one. MV3 service workers reject any module graph that contains
// top-level await, and libauth 3.x uses it in `default-crypto-instances.js`.
//
// `WebAssembly.Module`/`Instance` compile synchronously, which is allowed in
// worker contexts. This keeps libauth's own WASM implementations (including
// BCH's Schnorr variant) instead of substituting a different crypto library.
import { readFileSync } from "node:fs";

const LIBAUTH_BUILD = "/@bitauth/libauth/build/lib/";

const replaceOrThrow = (code, from, to, file) => {
  if (!code.includes(from)) {
    throw new Error(`[libauth-sync-crypto] Pattern not found in ${file}: ${from.slice(0, 80)}`);
  }
  return code.replace(from, to);
};

const patchHashes = (code, file) => {
  code = replaceOrThrow(
    code,
    "export const instantiateRustWasm = async (webassemblyBytes, expectedImportModuleName, hashExportName, initExportName, updateExportName, finalExportName) => {",
    "export const instantiateRustWasm = (webassemblyBytes, expectedImportModuleName, hashExportName, initExportName, updateExportName, finalExportName) => {",
    file,
  );
  code = replaceOrThrow(
    code,
    "const wasm = (await WebAssembly.instantiate(webassemblyBytes, {",
    "const wasm = (new WebAssembly.Instance(new WebAssembly.Module(webassemblyBytes), {",
    file,
  );
  return replaceOrThrow(
    code,
    "})).instance.exports; // eslint-disable-line @typescript-eslint/no-explicit-any",
    "})).exports; // eslint-disable-line @typescript-eslint/no-explicit-any",
    file,
  );
};

const patchHashModule = (code, file) => {
  const bytesFn = code.match(
    /export const (instantiate\w+Bytes) = async \(webassemblyBytes\) => \{/,
  );
  if (!bytesFn) throw new Error(`[libauth-sync-crypto] Missing hash factory in ${file}`);
  code = replaceOrThrow(
    code,
    bytesFn[0],
    `export const ${bytesFn[1]} = (webassemblyBytes) => {`,
    file,
  );
  code = replaceOrThrow(
    code,
    "const wasm = await instantiateRustWasm(",
    "const wasm = instantiateRustWasm(",
    file,
  );
  return code.replace(
    /export const (instantiate\w+) = async \(\) => (instantiate\w+Bytes)\(/,
    "export const $1 = () => $2(",
  );
};

const patchSecpWasm = (code, file) => {
  code = replaceOrThrow(
    code,
    "export const instantiateSecp256k1WasmBytes = async (webassemblyBytes) => {",
    "export const instantiateSecp256k1WasmBytes = (webassemblyBytes) => {",
    file,
  );
  code = replaceOrThrow(
    code,
    `    return WebAssembly.instantiate(webassemblyBytes, info).then((result) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
        getErrNoLocation = result.instance.exports['___errno_location'];
        return wrapSecp256k1Wasm(result.instance, heapU8, heapU32);
    });`,
    `    const instance = new WebAssembly.Instance(new WebAssembly.Module(webassemblyBytes), info);
    getErrNoLocation = instance.exports['___errno_location'];
    return wrapSecp256k1Wasm(instance, heapU8, heapU32);`,
    file,
  );
  return replaceOrThrow(
    code,
    "export const instantiateSecp256k1Wasm = async () => instantiateSecp256k1WasmBytes(",
    "export const instantiateSecp256k1Wasm = () => instantiateSecp256k1WasmBytes(",
    file,
  );
};

const patchSecp = (code, file) => {
  code = replaceOrThrow(
    code,
    "export const instantiateSecp256k1Bytes = async (webassemblyBytes, randomSeed) => wrapSecp256k1Wasm(await instantiateSecp256k1WasmBytes(webassemblyBytes), randomSeed);",
    "export const instantiateSecp256k1Bytes = (webassemblyBytes, randomSeed) => wrapSecp256k1Wasm(instantiateSecp256k1WasmBytes(webassemblyBytes), randomSeed);",
    file,
  );
  return replaceOrThrow(
    code,
    "export const instantiateSecp256k1 = async (randomSeed) => wrapSecp256k1Wasm(await instantiateSecp256k1Wasm(), randomSeed);",
    "export const instantiateSecp256k1 = (randomSeed) => wrapSecp256k1Wasm(instantiateSecp256k1Wasm(), randomSeed);",
    file,
  );
};

const DEFAULT_CRYPTO = `import { instantiateRipemd160 } from './ripemd160.js';
import { instantiateSecp256k1 } from './secp256k1.js';
import { instantiateSha1 } from './sha1.js';
import { instantiateSha256 } from './sha256.js';
import { instantiateSha512 } from './sha512.js';
const sha1 = instantiateSha1();
const sha256 = instantiateSha256();
const sha512 = instantiateSha512();
const ripemd160 = instantiateRipemd160();
const secp256k1 = instantiateSecp256k1();
export { ripemd160, secp256k1, sha1, sha256, sha512 };
//# sourceMappingURL=default-crypto-instances.js.map
`;

export function libauthSyncCrypto() {
  return {
    name: "libauth-sync-crypto",
    enforce: "pre",
    load(id) {
      const file = id.split("?")[0].replaceAll("\\", "/");
      if (!file.includes(LIBAUTH_BUILD)) return null;

      let code = readFileSync(file, "utf8");

      if (file.endsWith("/bin/hashes.js")) {
        code = patchHashes(code, file);
      } else if (/\/(sha1|sha256|sha512|ripemd160)\.js$/.test(file)) {
        code = patchHashModule(code, file);
      } else if (file.endsWith("/bin/secp256k1/secp256k1-wasm.js")) {
        code = patchSecpWasm(code, file);
      } else if (file.endsWith("/crypto/secp256k1.js")) {
        code = patchSecp(code, file);
      } else if (file.endsWith("/crypto/default-crypto-instances.js")) {
        code = DEFAULT_CRYPTO;
      } else {
        return null;
      }

      return { code, map: null };
    },
  };
}
