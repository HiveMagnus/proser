import { randomUUID } from 'node:crypto';
import { documentFromText, imagesOf, paragraphsOf, projectDocument, replaceDocumentText, regenerateDocumentText, type DocumentParagraph } from '@/documents/model';
import { validateDocument } from '@/documents/validation';
import { frozenTarget, protectedObjects, verifyTargets } from '@/documents/targets';
import { validateAnchorLineage } from '@/documents/lineage';
const image = { assetId: 1, sha256: 'a'.repeat(64), alt: 'A protected illustration', width: 100, height: 80 };
function fixture() {
  const document = documentFromText('Before 😀', randomUUID); const paragraph = document.blocks[0] as DocumentParagraph;
  paragraph.runs.push({ id: randomUUID(), text: '', style: {}, inlineImage: { ...image } }, { id: randomUUID(), text: ' after é.', style: { italic: true } });
  return { document, paragraph };
}
describe('canonical immutable inline images', () => {
  test('images project a protected character with exact surrounding Unicode spans', () => {
    const { document, paragraph } = fixture(); validateDocument(document);
    const projection = projectDocument(document); expect(projection.text).toBe('Before 😀\uFFFC after é.');
    expect(projection.spans[1]).toMatchObject({ blockId: paragraph.id, runId: paragraph.runs[1].id, start: 9, end: 10, editable: false });
    expect(imagesOf(document)[0]).toEqual({ type: 'image', id: paragraph.runs[1].id, ...image });
    expect(projection.wordCount).toBe(4);
  });
  test('text edits beside an image preserve its run and edits across it fail visibly', () => {
    const { document, paragraph } = fixture(); const protectedRun = structuredClone(paragraph.runs[1]);
    const revised = validateDocument(replaceDocumentText(document, 0, 6, 'Before', 'Beside', randomUUID));
    expect(paragraphsOf(revised)[0].runs.find((run) => run.id === protectedRun.id)).toEqual(protectedRun);
    expect(projectDocument(revised).text).toBe('Beside 😀\uFFFC after é.');
    const after = validateDocument(replaceDocumentText(document, 11, 16, 'after', 'beside', randomUUID));
    expect(projectDocument(after).text).toBe('Before 😀\uFFFC beside é.');
    expect(() => replaceDocumentText(document, 0, 12, projectDocument(document).text.slice(0, 12), 'Flattened', randomUUID)).toThrow('protected');
  });
  test('AI cannot edit an image-bearing target and its asset hash freezes adjacent targets', () => {
    const { document, paragraph } = fixture();
    const target = frozenTarget(document, { blockId: paragraph.id, from: 0, to: 6, sourceText: 'Before' });
    expect(target.editable).toBe(true);
    expect(frozenTarget(document, { blockId: paragraph.id, from: 0, to: 10, sourceText: 'Before 😀\uFFFC' }).editable).toBe(false);
    expect(protectedObjects(document)).toContainEqual({ blockId: paragraph.id, runId: paragraph.runs[1].id, inlineImage: image });
    paragraph.runs[1].inlineImage!.sha256 = 'b'.repeat(64); expect(() => verifyTargets(document, [target])).toThrow('changed');
  });
  test('images in cells and header/footer stories retain their asset identities', () => {
    const { document, paragraph } = fixture();
    document.blocks = [{ type: 'table', id: randomUUID(), widths: [100], rows: [{ id: randomUUID(), cells: [{ id: randomUUID(), paragraphs: [paragraph] }] }] }];
    const header = fixture().paragraph; const footer = fixture().paragraph;
    document.layout.header = [header]; document.layout.footer = [footer]; validateDocument(document);
    expect(imagesOf(document).map((item) => item.id)).toEqual([header.runs[1].id, paragraph.runs[1].id, footer.runs[1].id]);
    const table = document.blocks[0]; if (table.type !== 'table') throw new Error('fixture');
    expect(projectDocument(document).spans[1].cellId).toBe(table.rows[0].cells[0].id);
    paragraph.runs[1].text = 'Invented image text'; expect(() => validateDocument(document)).toThrow('protected empty');
  });
  test('full-scene regeneration cannot flatten inline objects', () => {
    const { document } = fixture();
    for (const paragraph of paragraphsOf(document)) for (const run of paragraph.runs) run.style = {};
    expect(() => regenerateDocumentText(document, 'A flattened passage.', randomUUID, { authorId: 1, authorName: 'Author', createdAt: '2026-10-05T00:00:00.000Z', origin: 'ai', status: 'pending' })).toThrow('protected');
  });
  test('moving an inline image proves its complete immutable metadata instead of matching empty text', () => {
    const { document, paragraph } = fixture(); const imageRun = paragraph.runs[1];
    const destination = structuredClone(document);
    const empty = { ...structuredClone(document), blocks: [] };
    const mapping = { kind: 'move' as const, source: { sceneId: 1, blockId: paragraph.id, runId: imageRun.id, from: 0, to: 0 }, target: { sceneId: 2, blockId: paragraph.id, runId: imageRun.id, from: 0, to: 0 } };
    const scopes = [{ sceneId: 1, previous: document, next: empty }, { sceneId: 2, previous: empty, next: destination }];
    expect(validateAnchorLineage([mapping], scopes)).toHaveLength(1);
    (destination.blocks[0] as DocumentParagraph).runs[1].inlineImage!.sha256 = 'b'.repeat(64);
    expect(() => validateAnchorLineage([mapping], scopes)).toThrow('formatting');
  });
});
