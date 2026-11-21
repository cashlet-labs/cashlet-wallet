import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { applyPaste, completion, isWord, suggest } from "../phrase";

interface WordBoxProps {
  index: number;
  value: string;
  onChange: (value: string) => void;
  onPaste: (text: string) => void;
  onDone: () => void;
  onFocusChange: (focused: boolean) => void;
  inputRef: (element: HTMLInputElement | null) => void;
}

/** One word box with suggestions from the BIP39 word list. */
function WordBox({
  index,
  value,
  onChange,
  onPaste,
  onDone,
  onFocusChange,
  inputRef,
}: WordBoxProps) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const matches = open ? suggest(value) : [];
  const invalid = value.length > 0 && !open && !isWord(value);

  const accept = (word: string) => {
    onChange(word);
    setOpen(false);
    onDone();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && matches.length > 0) {
      event.preventDefault();
      setHighlight((h) => (h + 1) % matches.length);
    } else if (event.key === "ArrowUp" && matches.length > 0) {
      event.preventDefault();
      setHighlight((h) => (h - 1 + matches.length) % matches.length);
    } else if (
      event.key === "Enter" ||
      event.key === " " ||
      (event.key === "Tab" && !event.shiftKey)
    ) {
      const word =
        matches[highlight] && matches.length > 1 ? matches[highlight]! : completion(value);
      if (word) {
        event.preventDefault();
        accept(word);
      } else if (event.key !== "Tab") {
        event.preventDefault();
      }
    } else if (event.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className={`word${invalid ? " invalid" : ""}`}>
      <span className="n" aria-hidden="true">
        {index + 1}
      </span>
      <input
        ref={inputRef}
        aria-label={`Word ${index + 1}`}
        aria-invalid={invalid}
        aria-autocomplete="list"
        aria-controls={matches.length > 0 ? listId : undefined}
        aria-expanded={matches.length > 0}
        role="combobox"
        value={value}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => {
          onChange(event.target.value.toLowerCase().replace(/[^a-z]/g, ""));
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => {
          setOpen(true);
          onFocusChange(true);
        }}
        onBlur={() => {
          setOpen(false);
          onFocusChange(false);
          // Leaving a box completes a unique prefix, as Tab would.
          const word = completion(value);
          if (word && word !== value) onChange(word);
        }}
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text");
          if (/\s/.test(text.trim())) {
            event.preventDefault();
            onPaste(text);
          }
        }}
      />
      {matches.length > 0 && (
        <ul className="suggestions" id={listId} role="listbox">
          {matches.map((word, i) => (
            <li
              key={word}
              role="option"
              aria-selected={i === highlight}
              // Before blur, so the click is not lost.
              onMouseDown={(event) => {
                event.preventDefault();
                accept(word);
              }}
            >
              {word}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Twelve (or twenty-four) word boxes. Typing suggests list words; Enter, Tab or
 * Space accepts a unique match and moves on; pasting a whole phrase into any box
 * fills them all.
 */
export function PhraseInput({
  words,
  onChange,
  onActiveChange,
}: {
  words: string[];
  onChange: (words: string[]) => void;
  /** The box being typed in, or null; its word is not judged until the user leaves it. */
  onActiveChange?: (index: number | null) => void;
}) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const [focus, setFocus] = useState<number | null>(null);

  useEffect(() => {
    if (focus !== null) refs.current[focus]?.focus();
  }, [focus]);

  return (
    <div className="phrase-grid" role="group" aria-label="Recovery phrase">
      {words.map((word, index) => (
        <WordBox
          key={index}
          index={index}
          value={word}
          inputRef={(element) => {
            refs.current[index] = element;
          }}
          onChange={(value) => onChange(words.map((w, i) => (i === index ? value : w)))}
          onPaste={(text) => {
            const result = applyPaste(words, index, text);
            onChange(result.words);
            setFocus(result.focus);
          }}
          onDone={() => setFocus(Math.min(words.length - 1, index + 1))}
          onFocusChange={(focused) => onActiveChange?.(focused ? index : null)}
        />
      ))}
    </div>
  );
}
