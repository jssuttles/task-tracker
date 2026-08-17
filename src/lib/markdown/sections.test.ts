import { describe, expect, it } from 'vitest';

import { splitSections, trimBlankEdges } from './sections.ts';

describe('splitSections', () => {
  it('puts everything before the first heading in the preamble', () => {
    const { preamble, sections } = splitSections('# Title\n\nsome text\n\n## Tasks\n\nbody');
    expect(preamble).toEqual(['# Title', '', 'some text', '']);
    expect(sections).toEqual([{ heading: '## Tasks', lines: ['', 'body'] }]);
  });

  it('splits multiple sections, trimming trailing whitespace off the heading', () => {
    const { sections } = splitSections('## Tasks  \n- a\n## Notes\n- b');
    expect(sections).toEqual([
      { heading: '## Tasks', lines: ['- a'] },
      { heading: '## Notes', lines: ['- b'] },
    ]);
  });

  it('treats a body with no heading as pure preamble', () => {
    const { preamble, sections } = splitSections('just some text');
    expect(preamble).toEqual(['just some text']);
    expect(sections).toEqual([]);
  });

  it('does not treat a single `#` heading as a section boundary', () => {
    const { preamble, sections } = splitSections('# Title\ntext');
    expect(preamble).toEqual(['# Title', 'text']);
    expect(sections).toEqual([]);
  });
});

describe('trimBlankEdges', () => {
  it('removes leading and trailing blank lines', () => {
    expect(trimBlankEdges(['', '  ', 'content', 'more', '', ''])).toEqual(['content', 'more']);
  });

  it('leaves interior blank lines alone', () => {
    expect(trimBlankEdges(['a', '', 'b'])).toEqual(['a', '', 'b']);
  });

  it('returns an empty array for all-blank input', () => {
    expect(trimBlankEdges(['', '  ', ''])).toEqual([]);
  });
});
