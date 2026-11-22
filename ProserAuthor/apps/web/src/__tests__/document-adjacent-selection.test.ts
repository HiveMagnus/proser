import { describe, expect, it } from 'vitest';
import { defaultLayout, type DocumentPassage } from '@cheftaco/proser-contracts';
import { adjacentPassageSelection } from '@/lib/document-adjacent-selection';
const passage = (sceneId: number, text: string): DocumentPassage => ({
  schemaVersion: 1,
  sceneId,
  bookRevisionId: 'book',
  sceneRevisionId: `scene-${sceneId}`,
  contentHash: 'a'.repeat(64),
  projection: 'final',
  cursor: { paragraph: 0, offset: 10 },
  windowHash: 'b'.repeat(64),
  images: [],
  changes: [],
  layout: defaultLayout(),
  omitted: { paragraphs: 0, objects: 0, comments: 0, changes: 0 },
  paragraphs: [
    {
      paragraph: {
        type: 'paragraph',
        id: `p-${sceneId}`,
        style: {},
        runs: [{ id: `r-${sceneId}`, text, style: {} }],
      },
      paragraphHash: 'c'.repeat(64),
      containerHash: 'd'.repeat(64),
      ordinal: 0,
      offset: 10,
      length: 100,
      continuedBefore: true,
      continuedAfter: true,
      runs: [
        {
          runId: `r-${sceneId}`,
          sourceHash: 'e'.repeat(64),
          from: 10,
          to: 10 + text.length,
          sourceLength: 100,
        },
      ],
    },
  ],
});
function fixture() {
  const root = document.createElement('div');
  root.innerHTML =
    '<div data-scene-id="4"><span data-block-id="p-4" data-run-id="r-4">A😀Z</span></div><div data-scene-id="5"><span data-block-id="p-5" data-run-id="r-5">A😀Z</span></div>';
  const [first, last] = root.querySelectorAll('span');
  const range = document.createRange();
  range.setStart(first!.firstChild!, 1);
  range.setEnd(last!.firstChild!, 3);
  return {
    root,
    range,
    first: first!,
    last: last!,
    passages: [passage(4, 'A😀Z'), passage(5, 'A😀Z')],
  };
}
describe('qualified adjacent DOM selection', () => {
  it('uses scene/run identities for repeated Unicode quotations and converts clipped offsets exactly', () => {
    const { root, range, passages } = fixture();
    expect(adjacentPassageSelection(root, range, passages)).toEqual([
      expect.objectContaining({
        sceneId: 4,
        expectedText: '😀Z',
        target: expect.objectContaining({ blockId: 'p-4', runId: 'r-4', from: 11, to: 14 }),
      }),
      expect.objectContaining({
        sceneId: 5,
        expectedText: 'A😀',
        target: expect.objectContaining({ blockId: 'p-5', runId: 'r-5', from: 10, to: 13 }),
      }),
    ]);
  });
  it('rejects a changed DOM source and a split Unicode grapheme rather than searching for matching text', () => {
    const { root, range, first, passages } = fixture();
    range.setStart(first.firstChild!, 2);
    expect(() => adjacentPassageSelection(root, range, passages)).toThrow('Unicode grapheme');
    range.setStart(first.firstChild!, 1);
    first.textContent = 'different';
    expect(() => adjacentPassageSelection(root, range, passages)).toThrow('changed');
  });
  it('rejects protected images and noncontiguous or read-only scene sources', () => {
    const { root, range, passages } = fixture();
    passages[0]!.paragraphs[0]!.paragraph.runs[0]!.inlineImage = {
      assetId: 1,
      sha256: 'f'.repeat(64),
      alt: 'owned',
      width: 10,
      height: 10,
    };
    expect(() => adjacentPassageSelection(root, range, passages)).toThrow('protected');
    delete passages[0]!.paragraphs[0]!.paragraph.runs[0]!.inlineImage;
    passages[1]!.projection = 'original';
    expect(() => adjacentPassageSelection(root, range, passages)).toThrow('read-only');
  });
});
