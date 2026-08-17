/**
 * `##`-delimited section splitting, shared by every vault document that owns
 * some headings and has to preserve the rest.
 *
 * Both the day file (`day.ts`) and the per-report team file (`team.ts`) are
 * "frontmatter + a handful of owned `##` sections + whatever else a human
 * added by hand." This is the one place that split and the trim it needs
 * before re-emitting a preserved section, so the two formats can't drift on
 * how "preserve unowned content" actually works.
 */

/** A heading and its body, preserved verbatim for sections a document doesn't own. */
export interface ExtraSection {
  heading: string;
  lines: string[];
}

interface Section {
  heading: string;
  lines: string[];
}

/** Split a body into `##`-delimited sections, keeping any preamble separate. */
export function splitSections(body: string): { preamble: string[]; sections: Section[] } {
  const preamble: string[] = [];
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const line of body.split('\n')) {
    if (/^##\s+/.test(line)) {
      current = { heading: line.trim(), lines: [] };
      sections.push(current);
      continue;
    }

    if (current === null) {
      preamble.push(line);
    } else {
      current.lines.push(line);
    }
  }

  return { preamble, sections };
}

/** Trim leading and trailing blank lines from a preserved section body. */
export function trimBlankEdges(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? '').trim() === '') start += 1;
  while (end > start && (lines[end - 1] ?? '').trim() === '') end -= 1;
  return lines.slice(start, end);
}
