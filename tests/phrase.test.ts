import { describe, expect, it } from "vitest";
import {
  applyPaste,
  backupQuestions,
  checkPhrase,
  completion,
  splitPhrase,
  suggest,
} from "../src/popup/phrase";

const VECTOR =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const empty = (n = 12) => Array.from({ length: n }, () => "");

describe("suggest and completion", () => {
  it("suggests list words by prefix", () => {
    expect(suggest("aba")).toEqual(["abandon"]);
    expect(suggest("ab")).toEqual(["abandon", "ability", "able", "about"]);
    expect(suggest("")).toEqual([]);
    expect(suggest("zzz")).toEqual([]);
  });

  it("completes a unique prefix or an exact word, never an ambiguous one", () => {
    expect(completion("aban")).toBe("abandon");
    expect(completion("able")).toBe("able");
    expect(completion("ab")).toBeNull();
    expect(completion("xyz")).toBeNull();
  });
});

describe("splitPhrase and applyPaste", () => {
  it("ignores numbering, commas and line breaks", () => {
    expect(splitPhrase("1. Abandon\n2) ability, able")).toEqual(["abandon", "ability", "able"]);
  });

  it("fills every box from the first when a whole phrase is pasted anywhere", () => {
    const { words, focus } = applyPaste(empty(), 5, VECTOR);
    expect(words.join(" ")).toBe(VECTOR);
    expect(focus).toBe(11);
  });

  it("fills from the current box when a few words are pasted", () => {
    const { words, focus } = applyPaste(empty(), 3, "able about");
    expect(words.slice(3, 5)).toEqual(["able", "about"]);
    expect(words[0]).toBe("");
    expect(focus).toBe(5);
  });

  it("never writes past the last box", () => {
    expect(applyPaste(empty(), 10, "able about abandon").words).toHaveLength(12);
  });
});

describe("checkPhrase", () => {
  it("accepts a valid phrase and normalises case", () => {
    expect(checkPhrase(VECTOR.toUpperCase().split(" "))).toEqual({
      state: "valid",
      phrase: VECTOR,
    });
  });

  it("reports unknown words by position, then missing words, then a bad checksum", () => {
    const words = VECTOR.split(" ");
    expect(checkPhrase(words.map((w, i) => (i === 2 ? "abandn" : w)))).toEqual({
      state: "unknown-words",
      positions: [3],
    });
    expect(checkPhrase(words.map((w, i) => (i === 11 ? "" : w)))).toEqual({ state: "incomplete" });
    expect(checkPhrase(words.map((w, i) => (i === 11 ? "abandon" : w)))).toEqual({
      state: "bad-checksum",
    });
  });

  it("works for 24 words", () => {
    const phrase24 = Array.from({ length: 23 }, () => "abandon").concat("art");
    expect(checkPhrase(phrase24).state).toBe("valid");
  });
});

describe("backupQuestions", () => {
  it("picks distinct, sorted positions within the phrase", () => {
    let seed = 0.42;
    const random = () => (seed = ((seed * 9301 + 49297) % 233280) / 233280);
    const positions = backupQuestions(12, 3, random);
    expect(new Set(positions).size).toBe(3);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(positions.every((p) => p >= 1 && p <= 12)).toBe(true);
  });
});
