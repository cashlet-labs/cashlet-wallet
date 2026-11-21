import { ServiceError } from "./api";

export const MIN_PASSWORD = 8;

/** A plain-language message for an error from the service. */
export function errorText(error: unknown): string {
  if (error instanceof ServiceError) {
    if (error.code === "WRONG_PASSWORD") return "That password is not right.";
    if (error.code === "LOCKED") return "The wallet locked. Unlock it to continue.";
    return sentence(error.message);
  }
  return error instanceof Error ? sentence(error.message) : "Something went wrong.";
}

function sentence(text: string): string {
  const capitalised = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

/**
 * Run `load` now and every `ms` milliseconds until the component unmounts.
 * Results are delivered asynchronously, never during render.
 */
export function poll(load: () => Promise<void>, ms: number): () => void {
  let alive = true;
  const run = () => {
    if (alive) void load();
  };
  queueMicrotask(run);
  const timer = setInterval(run, ms);
  return () => {
    alive = false;
    clearInterval(timer);
  };
}
