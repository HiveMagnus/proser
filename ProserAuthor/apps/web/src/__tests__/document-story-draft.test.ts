import { beforeAll, describe, expect, it, vi } from 'vitest';
import { webcrypto, createHash } from 'node:crypto';
import {
  canonicalDocument,
  documentFromText,
  type DocumentStorySourceRecord,
  type DocumentParagraph,
} from '@hivemagnus/proser-contracts';
import { storyDraftContext } from '@/lib/document-story-draft';
beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto);
});
const hash = (value: unknown) =>
  createHash('sha256').update(canonicalDocument(value)).digest('hex');
function source(): DocumentStorySourceRecord {
  let sequence = 0;
  const document = documentFromText(
    'Original 👩‍💻 story.\n\nSecond paragraph.',
    () => `story-${++sequence}`,
  );
  return {
    sourceKind: 'layout-story',
    bookId: 1,
    storyId: 'header',
    bookRevisionId: 'book',
    layoutRevisionId: 'layout',
    layoutContentHash: 'layout-hash',
    contentHash: hash(document),
    ownerContextHash: 'owner',
    document,
    styles: { text: {}, paragraph: {} },
  };
}
const block = (doc: DocumentStorySourceRecord['document'], index = 0) =>
  doc.blocks[index] as DocumentParagraph;
describe('bounded owned-story derivative', () => {
  it('hashes exact saved run/paragraph/container and retains supplied UUID through homogeneous Canvas splits', async () => {
    const saved = source(),
      current = structuredClone(saved.document),
      original = block(saved.document).runs[0]!;
    block(current).runs = [
      { ...original, id: 'canvas-a', text: 'Original ' },
      { ...original, id: 'canvas-b', text: '👩‍💻 revised story.' },
    ];
    const context = await storyDraftContext(
      saved,
      current,
      'reserved-operation',
      (key) => `intent-${key}`,
    );
    expect(context.localOperations?.operationId).toBe('reserved-operation');
    const operation = context.localOperations!.operations[0]!;
    expect(operation.kind).toBe('text');
    if (operation.kind !== 'text') throw new Error('expected text');
    expect(operation.target.runId).toBe(original.id);
    expect(operation.target.sourceHash).toBe(hash(original));
    const { runs: _runs, ...metadata } = block(saved.document);
    expect(operation.target.paragraphHash).toBe(hash(metadata));
    expect(operation.target.containerHash).toBe(
      hash({
        kind: 'body',
        blocks: saved.document.blocks.map((b) => ({ id: b.id, type: b.type })),
      }),
    );
    expect(operation.replacement).toBe('revised ');
    expect(context.targets[0]?.sourceText).toBe('Original 👩‍💻 revised story.');
    expect(
      await storyDraftContext(saved, current, 'reserved-operation', (key) => `intent-${key}`),
    ).toEqual(context);
  });
  it('prepares exact style intentions and does not silently combine incompatible local operations', async () => {
    const saved = source(),
      current = structuredClone(saved.document);
    block(current).style = { alignment: 'center' };
    block(current).runs[0]!.style = { bold: true };
    const context = await storyDraftContext(saved, current, 'op', (key) => key);
    expect(context.localOperations?.operations.map((op) => op.kind)).toEqual([
      'paragraph-format',
      'run-format',
    ]);
    block(current).runs[0]!.text = 'Changed';
    await expect(storyDraftContext(saved, current, 'op', (key) => key)).rejects.toThrow(
      'combined text and formatting',
    );
  });
  it('preserves protected objects, review, hierarchy and styled identities', async () => {
    const saved = source();
    for (const mutate of [
      (doc: typeof saved.document) => {
        doc.blocks.reverse();
      },
      (doc: typeof saved.document) => {
        block(doc).id = 'forged';
      },
      (doc: typeof saved.document) => {
        doc.comments.push({
          id: 'comment',
          body: 'forged',
          status: 'open',
          author: { id: 1, name: 'forged', origin: 'local' },
          createdAt: '2026-10-06',
          anchor: { blockId: block(doc).id, runId: block(doc).runs[0]!.id, from: 0, to: 1 },
        } as never);
      },
      (doc: typeof saved.document) => {
        block(doc).runs[0]!.inlineImage = {
          assetId: 1,
          sha256: 'x',
          alt: 'x',
          width: 1,
          height: 1,
        };
      },
    ]) {
      const current = structuredClone(saved.document);
      mutate(current);
      await expect(storyDraftContext(saved, current, 'op', (key) => key)).rejects.toThrow();
    }
    block(saved.document).runs[0]!.style = { bold: true };
    const current = structuredClone(saved.document);
    block(current).runs[0]!.id = 'unknown';
    block(current).runs[0]!.style = { italic: true };
    await expect(storyDraftContext(saved, current, 'op', (key) => key)).rejects.toThrow(
      'styled run identities',
    );
  });
});
