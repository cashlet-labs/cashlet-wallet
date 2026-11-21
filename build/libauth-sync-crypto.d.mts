import type { Plugin } from "vite";

/** Makes @bitauth/libauth's WebAssembly crypto load without top-level await. */
export function libauthSyncCrypto(): Plugin;
