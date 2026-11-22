import { describe, expect, it } from 'vitest';
import type { PassageRunSource, PassageOperationMapping } from '@cheftaco/proser-contracts';
import {
  passageRunGesture,
  materializeDeferredPassageIntent,
  type DeferredPassageRunIntent,
} from '../passage-intents';
const source = (): PassageRunSource => ({
  blockId: 'paragraph',
  paragraphHash: 'a'.repeat(64),
  containerHash: 'b'.repeat(64),
  runId: 'original-run',
  sourceHash: 'c'.repeat(64),
  from: 50000,
  to: 50006,
});
const mapping = (): PassageOperationMapping => ({
  operationId: 'format-operation',
  kind: 'run-format',
  relation: 'formatted',
  source: { ...source(), from: 50001, to: 50005 },
  target: {
    blockId: 'paragraph',
    paragraphHash: 'd'.repeat(64),
    containerHash: 'b'.repeat(64),
    runId: 'formatted-descendant',
    sourceHash: 'e'.repeat(64),
    from: 0,
    to: 4,
  },
  sourceTextHash: 'f'.repeat(64),
  targetTextHash: 'f'.repeat(64),
});
const deferred = (): DeferredPassageRunIntent => ({
  id: 'next-operation',
  basis: { kind: 'source', source: { ...source(), from: 50001, to: 50003 } },
  gesture: { kind: 'text', replacement: 'New' },
  expectedText: '😀',
});
describe('shared bounded gesture and introduced identity intents', () => {
  it('builds Canvas and semantic text/format gestures over immutable raw UTF16 slices', () => {
    const frozen = { source: source(), text: 'A😀éZ' };
    expect(
      passageRunGesture(
        frozen,
        1,
        5,
        {
          kind: 'run-format',
          patch: { set: { bold: true, characterStyleId: 'emphasis' }, unset: ['font'] },
        },
        'format-operation',
      ),
    ).toEqual({
      id: 'format-operation',
      kind: 'run-format',
      target: { ...source(), from: 50001, to: 50005 },
      expectedText: '😀é',
      patch: { set: { bold: true, characterStyleId: 'emphasis' }, unset: ['font'] },
    });
    expect(() =>
      passageRunGesture(frozen, 1, 2, { kind: 'text', replacement: 'X' }, 'bad'),
    ).toThrow('grapheme');
    expect(passageRunGesture(frozen, 5, 5, { kind: 'paragraph-split' }, 'split')).toMatchObject({
      kind: 'paragraph-split',
      target: { from: 50005, to: 50005 },
      expectedText: '',
    });
    expect(() => passageRunGesture(frozen, 1, 5, { kind: 'paragraph-split' }, 'split')).toThrow(
      'caret',
    );
  });
  it('rebases a later text intent only onto the exact formatted descendant', () => {
    expect(
      materializeDeferredPassageIntent(deferred(), {
        operationMappings: [mapping()],
        introducedIds: [],
      }),
    ).toMatchObject({
      id: 'next-operation',
      kind: 'text',
      target: {
        runId: 'formatted-descendant',
        paragraphHash: 'd'.repeat(64),
        sourceHash: 'e'.repeat(64),
        from: 0,
        to: 2,
      },
      expectedText: '😀',
      replacement: 'New',
    });
  });
  it('retains changed/deleted targets and ambiguous boundary carets for reconciliation', () => {
    expect(() =>
      materializeDeferredPassageIntent(deferred(), {
        operationMappings: [{ ...mapping(), relation: 'replacement' }],
        introducedIds: [],
      }),
    ).toThrow('reconciliation');
    const caret = deferred();
    caret.basis = { kind: 'source', source: { ...source(), from: 50001, to: 50001 } };
    expect(() =>
      materializeDeferredPassageIntent(caret, {
        operationMappings: [
          mapping(),
          {
            ...mapping(),
            relation: 'unchanged',
            target: { ...mapping().target!, runId: 'other-run' },
          },
        ],
        introducedIds: [],
      }),
    ).toThrow('unique');
  });
  it('binds typing into a newly inserted local run by operation and role, never by quotations', () => {
    const intent: DeferredPassageRunIntent = {
      id: 'continuation',
      basis: {
        kind: 'introduced',
        operationId: 'insert-operation',
        role: 'text-resource-1',
        from: 2,
        to: 2,
      },
      gesture: { kind: 'text', replacement: ' more' },
      expectedText: '',
    };
    const inserted: PassageOperationMapping = {
      ...mapping(),
      operationId: 'insert-operation',
      kind: 'text',
      relation: 'inserted',
      source: { ...source(), from: 50001, to: 50001 },
      target: { ...mapping().target!, runId: 'server-inserted', from: 0, to: 8 },
      targetTextHash: '9'.repeat(64),
    };
    const receipt = {
      operationMappings: [inserted],
      introducedIds: [
        { operationId: 'insert-operation', role: 'text-resource-1', id: 'server-inserted' },
      ],
    };
    expect(materializeDeferredPassageIntent(intent, receipt)).toMatchObject({
      target: { runId: 'server-inserted', sourceHash: 'e'.repeat(64), from: 2, to: 2 },
    });
    expect(() =>
      materializeDeferredPassageIntent(intent, {
        ...receipt,
        introducedIds: [{ ...receipt.introducedIds[0]!, role: 'other-role' }],
      }),
    ).toThrow('unique');
    expect(() =>
      materializeDeferredPassageIntent(
        {
          ...intent,
          basis: {
            ...(intent.basis as Extract<typeof intent.basis, { kind: 'introduced' }>),
            from: 9,
            to: 9,
          },
        },
        receipt,
      ),
    ).toThrow('reconciliation');
  });
});
