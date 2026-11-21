import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

/** Recovery phrases are 12 or 24 words (BIP39, 128 or 256 bits). */
export type PhraseLength = 12 | 24;

const WORDS = new Set(wordlist);

export function isWord(word: string): boolean {
  return WORDS.has(word);
}

/** Up to `limit` list words starting with `prefix`, for the suggestion list. */
export function suggest(prefix: string, limit = 4): string[] {
  const p = prefix.trim().toLowerCase();
  if (p.length === 0) return [];
  const matches: string[] = [];
  for (const word of wordlist) {
    if (word.startsWith(p)) {
      matches.push(word);
      if (matches.length === limit) break;
    }
  }
  return matches;
}

/**
 * The word to accept when the user presses Enter, Tab or Space: the typed word if
 * it is on the list, or the only word that starts with it. BIP39 words are unique
 * in their first four letters, so four letters are always enough.
 */
export function completion(prefix: string): string | null {
  const p = prefix.trim().toLowerCase();
  if (isWord(p)) return p;
  const matches = suggest(p, 2);
  return matches.length === 1 ? matches[0]! : null;
}

/** Split pasted text into words: any whitespace, numbering like "1." and commas are ignored. */
export function splitPhrase(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\b\d+[.)]/g, " ")
    .split(/[\s,]+/)
    .filter((word) => word.length > 0);
}

/**
 * Paste `text` into the boxes starting at `index`. A whole phrase pasted anywhere
 * fills every box from the first; a few words fill the boxes from `index`.
 */
export function applyPaste(
  words: readonly string[],
  index: number,
  text: string,
): { words: string[]; focus: number } {
  const pasted = splitPhrase(text);
  const next = [...words];
  const start = pasted.length === 12 || pasted.length === 24 ? 0 : index;
  pasted.slice(0, next.length - start).forEach((word, i) => (next[start + i] = word));
  return { words: next, focus: Math.min(next.length - 1, start + pasted.length) };
}

export type PhraseCheck =
  | { state: "incomplete" }
  | { state: "unknown-words"; positions: number[] }
  | { state: "bad-checksum" }
  | { state: "valid"; phrase: string };

/** Check the boxes: every word on the list, and the phrase's checksum correct. */
export function checkPhrase(words: readonly string[]): PhraseCheck {
  const clean = words.map((w) => w.trim().toLowerCase());
  const unknown = clean.flatMap((w, i) => (w.length > 0 && !isWord(w) ? [i + 1] : []));
  if (unknown.length > 0) return { state: "unknown-words", positions: unknown };
  if (clean.some((w) => w.length === 0)) return { state: "incomplete" };
  const phrase = clean.join(" ");
  return validateMnemonic(phrase, wordlist)
    ? { state: "valid", phrase }
    : { state: "bad-checksum" };
}

/** Pick `count` distinct positions (1-based) to ask about when checking a backup. */
export function backupQuestions(
  length: number,
  count = 3,
  random: () => number = Math.random,
): number[] {
  const positions = Array.from({ length }, (_, i) => i + 1);
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [positions[i], positions[j]] = [positions[j]!, positions[i]!];
  }
  return positions.slice(0, count).sort((a, b) => a - b);
}
