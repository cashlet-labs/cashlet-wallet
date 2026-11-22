import { checkWizardUri } from "./wizard";
import type { SiteGate } from "./sites";

/**
 * WizardConnect links that web pages show, found by the content script.
 *
 * The page is untrusted and the link is only a hint: nothing connects until
 * the user approves on the approval screen. The origin comes from the browser.
 * Each origin may have one request waiting, may be asked about the same link
 * once, and may cause only a few requests in a while. Pages learn nothing from
 * this: every call ends the same way for them, whatever the wallet did.
 */

export const MAX_URI_CHARS = 2_048;
/** Requests one origin may cause in each window. */
export const MAX_PROMPTS_PER_WINDOW = 3;
export const WINDOW_MS = 10 * 60_000;
const MAX_ORIGINS = 200;

interface OriginState {
  /** Links already asked about, with the time. */
  seen: Map<string, number>;
  /** When each request was made, newest last. */
  prompts: number[];
  /** The approval waiting for this origin, if any. */
  waiting: string | null;
}

export interface DetectDeps {
  gate: SiteGate;
  now: () => number;
  /** Connect after the user approves. Throws if the wallet is locked or the link is refused. */
  connect: (uri: string, origin: string) => void;
}

export class WizardDetector {
  private readonly origins = new Map<string, OriginState>();

  constructor(private readonly deps: DetectDeps) {}

  /**
   * A link a page showed. Asks the user unless the link is invalid, was asked
   * about already, or the origin is over its limits. Resolves when the request
   * is answered or dropped; it never tells the page which.
   */
  async detect(origin: string, uri: unknown, signal?: AbortSignal): Promise<void> {
    if (typeof uri !== "string" || uri.length > MAX_URI_CHARS || signal?.aborted) return;
    let link: string;
    try {
      link = checkWizardUri(uri);
    } catch {
      return;
    }
    const now = this.deps.now();
    this.prune(now);
    const state: OriginState = this.origins.get(origin) ?? {
      seen: new Map(),
      prompts: [],
      waiting: null,
    };
    if (state.waiting !== null || state.seen.has(link)) return;
    if (state.prompts.length >= MAX_PROMPTS_PER_WINDOW) return;
    if (!this.origins.has(origin) && this.origins.size >= MAX_ORIGINS) return;
    this.origins.set(origin, state);

    const queued = this.deps.gate.queue({ origin, type: "wizard", transaction: null }, async () => {
      this.deps.connect(link, origin);
      return null;
    });
    if (!queued.ok) return;
    state.seen.set(link, now);
    state.prompts.push(now);
    state.waiting = queued.id;
    // The page closing withdraws the request.
    signal?.addEventListener("abort", () =>
      this.deps.gate.cancel(queued.id, "the page was closed"),
    );
    await queued.result.then(
      () => undefined,
      () => undefined,
    );
    if (state.waiting === queued.id) state.waiting = null;
  }

  private prune(now: number): void {
    for (const [origin, state] of this.origins) {
      state.prompts = state.prompts.filter((t) => now - t < WINDOW_MS);
      for (const [link, t] of state.seen) if (now - t >= WINDOW_MS) state.seen.delete(link);
      if (state.waiting === null && state.prompts.length === 0 && state.seen.size === 0)
        this.origins.delete(origin);
    }
  }
}
