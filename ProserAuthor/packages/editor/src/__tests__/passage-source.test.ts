import { describe, expect, it } from 'vitest';
import {
  defaultLayout,
  type DocumentPassage,
  type DocumentPassageSourceFrame,
} from '@cheftaco/proser-contracts';
import { qualifyPassageSelection, validatePassageSource } from '../passage-source';
import type { DocumentSelection } from '../document-selection';
const sourceFrame = (): DocumentPassageSourceFrame => ({
  bookId: 1,
  actId: 2,
  chapterId: 3,
  sceneId: 4,
  bookRevisionId: 'book-rev',
  bookContentHash: 'a'.repeat(64),
  sceneRevisionId: 'scene-rev',
  sceneContentHash: 'b'.repeat(64),
  qualifiedMembershipHash: 'c'.repeat(64),
  structureScope: { revisionId: 'structure-rev', contentHash: 'd'.repeat(64) },
  layoutScope: { revisionId: 'layout-rev', contentHash: 'e'.repeat(64) },
  effectiveStyleLayoutHash: 'f'.repeat(64),
  projection: 'final',
});
const passage = (): DocumentPassage => ({
  sourceFrame: sourceFrame(),
  schemaVersion: 1,
  bookRevisionId: 'book-rev',
  sceneId: 4,
  sceneRevisionId: 'scene-rev',
  contentHash: 'b'.repeat(64),
  projection: 'final',
  cursor: { paragraph: 100, offset: 50000 },
  paragraphs: [
    {
      paragraph: {
        type: 'paragraph',
        id: 'paragraph',
        style: { indent: 12 },
        runs: [{ id: 'run', text: 'A😀éZ', style: { italic: true } }],
      },
      ordinal: 100,
      offset: 50000,
      length: 1200000,
      continuedBefore: true,
      continuedAfter: true,
      runs: [
        { runId: 'run', sourceHash: 'a'.repeat(64), from: 50000, to: 50006, sourceLength: 1200000 },
      ],
      container: { tableId: 'table', rowId: 'row', cellId: 'cell', widths: [800, 400] },
    },
  ],
  images: [],
  changes: [],
  omitted: { paragraphs: 900, objects: 1, comments: 2, changes: 0 },
  layout: defaultLayout(),
  windowHash: '9'.repeat(64),
});
const selection = (): DocumentSelection => ({
  projection: 'final',
  targets: [{ blockId: 'paragraph', from: 1, to: 5, sourceText: '😀é' }],
  runs: [{ blockId: 'paragraph', runId: 'run', from: 1, to: 5 }],
  container: { tableId: 'table', rowId: 'row', cellId: 'cell' },
});
describe('passage source and selection authority', () => {
  it('validates owned book/chapter, immutable body and style/layout scopes', () => {
    expect(validatePassageSource(passage(), { bookId: 1, sceneId: 4 })).toEqual(sourceFrame());
    expect(() => validatePassageSource(passage(), { bookId: 8, sceneId: 4 })).toThrow('owned');
    expect(() =>
      validatePassageSource(passage(), { bookId: 1, sceneId: 4, bookRevisionId: 'new-head' }),
    ).toThrow('owned');
    const bad = passage();
    bad.sourceFrame!.sceneRevisionId = 'another-scene';
    expect(() => validatePassageSource(bad, { bookId: 1, sceneId: 4 })).toThrow('owned');
    expect(() =>
      validatePassageSource({ ...passage(), sourceFrame: undefined }, { bookId: 1, sceneId: 4 }),
    ).toThrow('source frame');
  });
  it('maps exact UTF16 fragment offsets into the supplied canonical run and table cell', () => {
    const window = passage();
    const before = structuredClone(window);
    expect(qualifyPassageSelection(window, selection(), { bookId: 1, sceneId: 4 })).toEqual({
      sourceFrame: sourceFrame(),
      projection: 'final',
      windowHash: '9'.repeat(64),
      ranges: [
        {
          blockId: 'paragraph',
          runId: 'run',
          sourceHash: 'a'.repeat(64),
          from: 50001,
          to: 50005,
          sourceText: '😀é',
          container: { tableId: 'table', rowId: 'row', cellId: 'cell' },
        },
      ],
    });
    expect(window).toEqual(before);
  });
  it('refuses stale text, wrong containers and unqualified repeated quotations', () => {
    const wrong = selection();
    wrong.container.cellId = 'same-quote-other-cell';
    expect(() => qualifyPassageSelection(passage(), wrong, { bookId: 1, sceneId: 4 })).toThrow(
      'container',
    );
    const stale = selection();
    stale.targets[0]!.sourceText = 'different';
    expect(() => qualifyPassageSelection(passage(), stale, { bookId: 1, sceneId: 4 })).toThrow(
      'text changed',
    );
    const missing = selection();
    missing.runs[0]!.runId = 'other-identical-run';
    expect(() => qualifyPassageSelection(passage(), missing, { bookId: 1, sceneId: 4 })).toThrow(
      'immutable',
    );
  });
  it('does not let selected run offsets disagree with the paragraph target', () => {
    const forged = selection();
    forged.runs[0]!.from = 0;
    expect(() => qualifyPassageSelection(passage(), forged, { bookId: 1, sceneId: 4 })).toThrow(
      'frozen',
    );
    const omitted = selection();
    omitted.runs = [];
    expect(() => qualifyPassageSelection(passage(), omitted, { bookId: 1, sceneId: 4 })).toThrow(
      'omits',
    );
  });
  it('rejects partial graphemes and protected images without changing the source', () => {
    const split = selection();
    split.targets[0] = { blockId: 'paragraph', from: 1, to: 2, sourceText: '\ud83d' };
    split.runs[0]!.to = 2;
    expect(() => qualifyPassageSelection(passage(), split, { bookId: 1, sceneId: 4 })).toThrow(
      'grapheme',
    );
    const object = passage();
    object.paragraphs[0]!.paragraph.runs[0]!.inlineImage = {
      assetId: 3,
      sha256: 'a'.repeat(64),
      width: 30,
      height: 20,
      alt: 'Protected',
    };
    const image = selection();
    image.targets[0] = { blockId: 'paragraph', from: 0, to: 1, sourceText: '\ufffc' };
    image.runs[0]!.from = 0;
    image.runs[0]!.to = 0;
    expect(() => qualifyPassageSelection(object, image, { bookId: 1, sceneId: 4 })).toThrow(
      'protected',
    );
  });
});
