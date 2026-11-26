import { parsePlainManuscript } from '@/lib/importers/plainManuscript';

const parse = (text: string | Buffer, format: 'markdown' | 'plain-text') => parsePlainManuscript(Buffer.isBuffer(text) ? text : Buffer.from(text), format, 'Fallback title');
const outline = (result: ReturnType<typeof parse>) => result.acts.map((act) => ({ act: act.title, chapters: act.chapters.map((chapter) => ({ title: chapter.title, scenes: chapter.scenes.map((scene) => scene.prose) })) }));

describe('Markdown and plain-text manuscript mapping', () => {
  test('Markdown: a lone first heading is the title, chapter headings start chapters, breaks start scenes', () => {
    const result = parse('# My Novel\nby Jane Writer\n\nA short foreword.\n\n## Chapter One\n\nIt was *dark*\nand stormy.  \nA hard break.\n\n***\n\nScene two.\n\n### A subhead\n\nMore.\n\n## Chapter Two\n', 'markdown');
    expect(result).toMatchObject({ title: 'My Novel', byline: 'by Jane Writer', sceneBreakCount: 1, demotedHeadingCount: 1, paragraphMode: 'blank-line', encoding: 'utf-8' });
    expect(outline(result)).toEqual([{ act: 'Imported Manuscript', chapters: [
      { title: 'Opening', scenes: ['A short foreword.'] },
      { title: 'Chapter One', scenes: ['It was *dark* and stormy.\nA hard break.', 'Scene two.\n\nA subhead\n\nMore.'] },
      { title: 'Chapter Two', scenes: [''] },
    ] }]);
  });
  test('Markdown: part headings above chapters become acts; front matter and fenced code are not structure', () => {
    const result = parse('---\ntitle: "Front Title"\nauthor: X\n---\n# Part One\n## The Gate\nText one.\n```\n# not a heading\n```\n# Part Two: Return\n## The Road\n\nText two.\n', 'markdown');
    expect(result).toMatchObject({ title: 'Front Title', frontmatterRemoved: true });
    expect(outline(result).map((act) => [act.act, act.chapters.map((chapter) => chapter.title)])).toEqual([['Part One', ['The Gate']], ['Part Two: Return', ['The Road']]]);
    expect(result.acts[0].chapters[0].scenes[0].prose).toContain('# not a heading');
  });
  test('Markdown without headings is one chapter; a single heading names that chapter', () => {
    expect(outline(parse('Just prose.\n\nSecond paragraph.', 'markdown'))).toEqual([{ act: 'Imported Manuscript', chapters: [{ title: 'Imported Chapter', scenes: ['Just prose.\n\nSecond paragraph.'] }] }]);
    const single = parse('# Chapter 7\n\nAlone.', 'markdown');
    expect(single.title).toBe('Fallback title');
    expect(outline(single)[0].chapters.map((chapter) => chapter.title)).toEqual(['Chapter 7']);
  });
  test('plain text: chapter lines, roman numerals and named sections start chapters; prose mentioning a chapter does not', () => {
    const result = parse('THE TITLE\n\nChapter 1\n\nIt began.\nStill the same paragraph.\n\nChapter two was worse.\n\n* * *\n\nLater.\n\nCHAPTER II: Storm\n\nRain *falls*.\n\nEpilogue\n\nEnd.', 'plain-text');
    expect(result.title).toBe('THE TITLE');
    expect(outline(result)).toEqual([{ act: 'Imported Manuscript', chapters: [
      { title: 'Chapter 1', scenes: ['It began. Still the same paragraph.\n\nChapter two was worse.', 'Later.'] },
      { title: 'CHAPTER II: Storm', scenes: ['Rain *falls*.'] },
      { title: 'Epilogue', scenes: ['End.'] },
    ] }]);
  });
  test('plain text saved one paragraph per line keeps each line as a paragraph; parts become acts', () => {
    const result = parse('Part One\nChapter 1\nFirst paragraph.\nSecond paragraph.\nAct did nothing here\nChapter Two\nAnother.\nPart Two\nChapter Three The Return\nDone.', 'plain-text');
    expect(result.paragraphMode).toBe('line');
    expect(outline(result)).toEqual([
      { act: 'Part One', chapters: [{ title: 'Chapter 1', scenes: ['First paragraph.\n\nSecond paragraph.\n\nAct did nothing here'] }, { title: 'Chapter Two', scenes: ['Another.'] }] },
      { act: 'Part Two', chapters: [{ title: 'Chapter Three The Return', scenes: ['Done.'] }] },
    ]);
  });
  test('non-UTF-8 text is read as Windows-1252, a BOM is dropped, and binary or empty files are refused', () => {
    const latin = parse(Buffer.concat([Buffer.from('Caf'), Buffer.from([0xe9]), Buffer.from(' '), Buffer.from([0x93]), Buffer.from('quoted'), Buffer.from([0x94])]), 'plain-text');
    expect(latin.encoding).toBe('windows-1252');
    expect(latin.acts[0].chapters[0].scenes[0].prose).toBe('Café “quoted”');
    expect(parse(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Text.')]), 'markdown').acts[0].chapters[0].scenes[0].prose).toBe('Text.');
    expect(() => parse(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), 'plain-text')).toThrow(expect.objectContaining({ code: 'DOCUMENT_IMPORT_INVALID' }));
    expect(() => parse('\n\n   \n', 'markdown')).toThrow(expect.objectContaining({ code: 'DOCUMENT_IMPORT_EMPTY' }));
  });
  test('long manuscripts stay inside the outline bounds', () => {
    const chapters = Array.from({ length: 150 }, (_, index) => `## Chapter ${index + 1}\n\nText ${index + 1}.`).join('\n\n');
    const result = parse(chapters, 'markdown');
    expect(result.acts.map((act) => act.chapters.length)).toEqual([100, 50]);
    const scenes = `## Chapter 1\n\n${Array.from({ length: 101 }, (_, index) => `Scene ${index}.`).join('\n\n***\n\n')}`;
    expect(() => parse(scenes, 'markdown')).toThrow(expect.objectContaining({ code: 'DOCUMENT_IMPORT_TOO_LARGE' }));
  });
});
describe('heading patterns', () => {
  test('ordinary sentences that start with Part or Chapter stay prose', () => {
    const result = parse('Chapter 1\n\nPart and parcel of the plan\n\nChapter and verse were quoted.\n\nChapter One Hundred and Five\n\nEnd.', 'plain-text');
    expect(result.acts[0].chapters.map((chapter) => chapter.title)).toEqual(['Chapter 1', 'Chapter One Hundred and Five']);
    expect(result.acts).toHaveLength(1);
  });
});
