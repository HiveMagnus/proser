import { parseManuscript } from '../lib/importers/legacyManuscript';

describe('parseManuscript', () => {
  it('splits imported chapters into multiple scenes using manuscript separators', () => {
    // A disposable source fixture keeps this regression independent of private
    // manuscript exports that are deliberately absent from a fresh checkout.
    const source = [
      '# Separator fixture',
      'by Test Author',
      '## Act One',
      '### Chapter 1: Arrival',
      'Opening scene.',
      '* * *',
      'Weeks ago, the fictional visitor had arrived.',
      '* * *',
      'A third scene with **emphasis**.',
      '* * *',
      'The air was thick with unspoken words.',
      '### Chapter 2: Discovery',
      'One.', '* * *', 'Two.', '* * *', 'Three.',
      '### Chapter 3: Departure',
      'One.', '* * *', 'Two.', '* * *', 'Three.', '* * *', 'Four.', '* * *', 'Five.',
      '## Act Two',
      '### Chapter 4: Return',
      'One.', '* * *', 'Two.', '* * *', 'Three.',
    ].join('\r\n');
    const manuscript = parseManuscript(source, 'Fallback title');

    expect(manuscript.title).toBe('Separator fixture');
    expect(manuscript.byline).toBe('by Test Author');

    expect(manuscript.acts).toHaveLength(2);
    expect(manuscript.acts[0]?.chapters).toHaveLength(3);
    expect(manuscript.acts[1]?.chapters).toHaveLength(1);

    expect(manuscript.acts[0]?.chapters[0]?.scenes).toHaveLength(4);
    expect(manuscript.acts[0]?.chapters[1]?.scenes).toHaveLength(3);
    expect(manuscript.acts[0]?.chapters[2]?.scenes).toHaveLength(5);
    expect(manuscript.acts[1]?.chapters[0]?.scenes).toHaveLength(3);

    expect(manuscript.acts[0]?.chapters[0]?.scenes[1]?.summary).toMatch(/Weeks ago, the fictional visitor had arrived/i);
    expect(manuscript.acts[0]?.chapters[0]?.scenes[2]?.summary).toBe('A third scene with emphasis.');
    expect(manuscript.acts[0]?.chapters[0]?.scenes[3]?.summary).toMatch(/The air was thick with unspoken words/i);
  });
});
