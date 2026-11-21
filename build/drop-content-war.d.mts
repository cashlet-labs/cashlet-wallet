import type { Plugin } from "vite";

/** Removes crxjs's web-accessible entries for content scripts from the built manifest. */
export function dropContentScriptResources(): Plugin;
