import { describe, expect, it } from 'vitest';

import {
  BLOCKER_TAG,
  extractPeople,
  extractTags,
  isBlocker,
  isKudos,
  KUDOS_TAG,
} from './mentions.ts';

describe('extractPeople', () => {
  it('finds a mention', () => {
    expect(extractPeople('@alice shipped it')).toEqual(['alice']);
  });

  it('lowercases handles so @Alice and @alice are one person', () => {
    expect(extractPeople('@Alice and @alice')).toEqual(['alice']);
  });

  it('de-duplicates and preserves first-appearance order', () => {
    expect(extractPeople('@bob paired with @alice, then @bob reviewed')).toEqual(['bob', 'alice']);
  });

  it('does not treat an email address as a mention', () => {
    expect(extractPeople('ping jason@example.com about it')).toEqual([]);
  });

  it('drops trailing punctuation from the handle', () => {
    expect(extractPeople('great work @alice.')).toEqual(['alice']);
    expect(extractPeople('thanks @bob, really')).toEqual(['bob']);
  });

  it('accepts dots, dashes and underscores inside a handle', () => {
    expect(extractPeople('@ana-maria and @jo_smith and @a.b')).toEqual([
      'ana-maria',
      'jo_smith',
      'a.b',
    ]);
  });

  it('accepts a single-character handle', () => {
    expect(extractPeople('@j pinged me')).toEqual(['j']);
  });

  it('returns nothing for text without mentions', () => {
    expect(extractPeople('just a plain note')).toEqual([]);
  });

  it('is reentrant across calls despite the shared global pattern', () => {
    expect(extractPeople('@alice')).toEqual(['alice']);
    expect(extractPeople('@alice')).toEqual(['alice']);
  });
});

describe('extractTags', () => {
  it('finds tags and lowercases them', () => {
    expect(extractTags('shipped it #Kudos #release')).toEqual(['kudos', 'release']);
  });

  it('ignores a hash that follows a word character', () => {
    expect(extractTags('wrote some C# today')).toEqual([]);
  });

  it('ignores a numeric fragment such as an issue reference', () => {
    expect(extractTags('see #123')).toEqual([]);
  });

  it('de-duplicates', () => {
    expect(extractTags('#kudos and more #kudos')).toEqual(['kudos']);
  });
});

describe('isKudos', () => {
  it('detects the kudos tag', () => {
    expect(isKudos('@alice saved the release #kudos')).toBe(true);
    expect(isKudos('@alice saved the release')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isKudos(`nice work #${KUDOS_TAG.toUpperCase()}`)).toBe(true);
  });
});

describe('isBlocker', () => {
  it('detects the blocker tag', () => {
    expect(isBlocker('waiting on design review #blocker')).toBe(true);
    expect(isBlocker('waiting on design review')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isBlocker(`stuck #${BLOCKER_TAG.toUpperCase()}`)).toBe(true);
  });

  it('does not false-positive on a longer tag sharing the same prefix', () => {
    expect(isBlocker('#blockers everywhere')).toBe(false);
  });
});
