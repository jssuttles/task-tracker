/**
 * Inline `@person` and `#tag` extraction.
 *
 * This is the whole reason the vault is worth keeping. Typing
 * `@alice unblocked the release single-handedly #kudos` costs nothing in the
 * moment, but it is what makes "what did Alice actually ship this year?"
 * answerable in December instead of a memory exercise.
 *
 * Extraction is read-only and derived on demand — mentions are never written
 * back into the file as metadata, so the note text stays exactly as typed.
 */

/**
 * `@name` where the `@` is not preceded by a word character.
 *
 * That lookbehind is what keeps `jason@example.com` from registering
 * `@example` as a colleague. Trailing `.`/`-`/`_` are excluded from the capture
 * so `@alice.` at the end of a sentence yields `alice`.
 */
const PERSON_PATTERN = /(?<![\w@])@([A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]|[A-Za-z0-9])/g;

/** `#tag`, with the same no-preceding-word-character rule (skips `C#`, URLs). */
const TAG_PATTERN = /(?<![\w#])#([A-Za-z][A-Za-z0-9_-]*)/g;

/** The tag that marks a moment worth remembering at review time. */
export const KUDOS_TAG = 'kudos';
/** The tag that marks something impeding progress. */
export const BLOCKER_TAG = 'blocker';

function extract(text: string, pattern: RegExp, lowercase: boolean): string[] {
  const seen = new Set<string>();
  const found: string[] = [];

  // `matchAll` needs the global flag and does not mutate `lastIndex` on the
  // shared literal, so the module-level patterns stay reentrant.
  for (const match of text.matchAll(pattern)) {
    const raw = match[1];
    if (raw === undefined) continue;

    const value = lowercase ? raw.toLowerCase() : raw;
    if (seen.has(value)) continue;
    seen.add(value);
    found.push(value);
  }

  return found;
}

/**
 * People mentioned in `text`, de-duplicated, in first-appearance order.
 *
 * Handles are lowercased so `@Alice` and `@alice` are the same person when you
 * later ask who did what.
 */
export function extractPeople(text: string): string[] {
  return extract(text, PERSON_PATTERN, true);
}

/** Tags in `text`, lowercased, de-duplicated, in first-appearance order. */
export function extractTags(text: string): string[] {
  return extract(text, TAG_PATTERN, true);
}

/** `true` when the text carries the kudos tag. */
export function isKudos(text: string): boolean {
  return extractTags(text).includes(KUDOS_TAG);
}

/** `true` when the text carries the blocker tag. */
export function isBlocker(text: string): boolean {
  return extractTags(text).includes(BLOCKER_TAG);
}
