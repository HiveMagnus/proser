import { describe, expect, it } from 'vitest';
import {
  defaultLayout,
  type DocumentPassage,
  type ProserDocument,
} from '@cheftaco/proser-contracts';
import { passageDocument, passageDocumentOperations } from '@/lib/document-passage-document';
const paragraph = {
  type: 'paragraph' as const,
  id: 'p',
  style: {},
  runs: [{ id: 'r', text: 'A😀éZ', style: { italic: true } }],
};
const passage: DocumentPassage = {
  schemaVersion: 1,
  bookRevisionId: 'book',
  sceneId: 1,
  sceneRevisionId: 'scene',
  contentHash: 'a'.repeat(64),
  projection: 'final',
  cursor: { paragraph: 0, offset: 0 },
  windowHash: 'b'.repeat(64),
  layout: defaultLayout(),
  images: [],
  changes: [],
  omitted: { paragraphs: 10000, comments: 0, changes: 0, objects: 0 },
  paragraphs: [
    {
      paragraph,
      paragraphHash: 'c'.repeat(64),
      containerHash: 'd'.repeat(64),
      ordinal: 0,
      offset: 500,
      length: 1000,
      continuedBefore: true,
      continuedAfter: true,
      runs: [{ runId: 'r', sourceHash: 'e'.repeat(64), from: 500, to: 506, sourceLength: 1000 }],
    },
  ],
};
let seq = 0;
const id = () => `intent-${++seq}`;
describe('bounded passage document intents', () => {
  it('maps sliced Unicode text to original run coordinates and preserves formatting', () => {
    const before = passageDocument(passage),
      after = structuredClone(before);
    if (after.blocks[0]!.type === 'paragraph') after.blocks[0]!.runs[0]!.text = 'A😀éZ more';
    expect(passageDocumentOperations(passage, before, after, id)).toEqual([
      expect.objectContaining({
        kind: 'text',
        expectedText: '',
        replacement: ' more',
        target: expect.objectContaining({
          blockId: 'p',
          runId: 'r',
          from: 506,
          to: 506,
          sourceHash: 'e'.repeat(64),
        }),
      }),
    ]);
    expect(before.blocks[0]).toEqual(paragraph);
  });
  it('translates a style split to the supplied source identity, not the local new ID', () => {
    const before = passageDocument(passage),
      after = structuredClone(before);
    if (after.blocks[0]!.type !== 'paragraph') throw new Error('paragraph');
    after.blocks[0]!.runs = [
      { id: 'r', text: 'A', style: { italic: true } },
      { id: 'local-untrusted', text: '😀é', style: { italic: true, bold: true } },
      { id: 'local-tail', text: 'Z', style: { italic: true } },
    ];
    expect(passageDocumentOperations(passage, before, after, id)).toEqual([
      expect.objectContaining({
        kind: 'run-format',
        expectedText: '😀é',
        target: expect.objectContaining({ runId: 'r', from: 501, to: 505 }),
        patch: { set: { bold: true } },
      }),
    ]);
  });
  it('rejects source omissions and protected object changes instead of flattening them', () => {
    expect(() =>
      passageDocument({ ...passage, omitted: { ...passage.omitted, objects: 1 } }),
    ).toThrow('ordered object');
    const before = passageDocument(passage),
      after = structuredClone(before);
    after.blocks.push({ type: 'pageBreak', id: 'native-local' });
    expect(() => passageDocumentOperations(passage, before, after, id)).toThrow('object controls');
    const source = {
      ...passage,
      paragraphs: [{ ...passage.paragraphs[0]!, paragraphHash: undefined }],
    };
    if (after.blocks[0]!.type === 'paragraph') after.blocks[0]!.runs[0]!.text += 'new';
    after.blocks.pop();
    expect(() => passageDocumentOperations(source, before, after, id)).toThrow(
      'immutable paragraph source',
    );
  });
  it('does not silently drop simultaneous new formatting while typing', () => {
    const before = passageDocument(passage),
      after = structuredClone(before);
    if (after.blocks[0]!.type !== 'paragraph') throw new Error('paragraph');
    after.blocks[0]!.runs[0]!.text += 'new';
    after.blocks[0]!.runs[0]!.style.bold = true;
    expect(() => passageDocumentOperations(passage, before, after, id)).toThrow('Save typing');
  });
  it('formats paragraphs without using Canvas command names or local review attribution', () => {
    const before = passageDocument(passage),
      after = structuredClone(before);
    if (after.blocks[0]!.type !== 'paragraph') throw new Error('paragraph');
    after.blocks[0]!.style = { alignment: 'center', heading: 2 };
    const operations = passageDocumentOperations(passage, before, after, id);
    expect(operations).toEqual([
      expect.objectContaining({
        kind: 'paragraph-format',
        patch: { set: { alignment: 'center', heading: 2 } },
      }),
    ]);
    expect(JSON.stringify(operations)).not.toMatch(/authorId|commands|changes/);
  });
  it('protects layout and comments from a body document callback', () => {
    const before = passageDocument(passage),
      after: ProserDocument = structuredClone(before);
    after.layout.fontSize = 40;
    expect(() => passageDocumentOperations(passage, before, after, id)).toThrow('owned controls');
  });
});
