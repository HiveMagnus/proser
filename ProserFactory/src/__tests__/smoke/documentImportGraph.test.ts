import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { documentFromText, defaultLayout } from '@/documents/model';
import { extractDocumentLayoutStories } from '@/documents/layoutStories';
import { verifyImportedGraph, type ImportedStoryMapping } from '@/documents/importGraph';
import type { BookLayoutSnapshot } from '@/documents/scope-model';

describe('retained complete import graph attestation', () => {
  const fixture = () => {
    const source = documentFromText('Owned body 😀 é.', randomUUID);
    const header = documentFromText('Imported header', randomUUID).blocks[0]; if (header.type !== 'paragraph') throw new Error('fixture');
    const changeId = randomUUID(); header.runs[0].style = { italic: true }; header.runs[0].changeId = changeId; source.layout.header = [header];
    source.changes.push({ id: changeId, kind: 'insertion', status: 'pending', authorId: 0, authorName: 'Imported writer', importedAuthor: 'Imported writer', origin: 'import', createdAt: '2026-01-02T03:04:05.000Z', targetRunIds: [header.runs[0].id] });
    source.comments.push({ id: randomUUID(), authorId: 0, authorName: 'Imported writer', importedAuthor: 'Imported writer', createdAt: '2026-01-02T03:04:05.000Z', text: 'Imported comment', resolved: false, anchors: [{ blockId: header.id, runId: header.runs[0].id, start: 0, end: header.runs[0].text.length, sourceText: header.runs[0].text }] });
    const extracted = extractDocumentLayoutStories(source, 12);
    const layout: BookLayoutSnapshot = { schemaVersion: 1, book: defaultLayout(), chapters: { '12': extracted.document.layout }, styles: { text: {}, paragraph: {} }, frontMatter: [], backMatter: [], headerFooterStories: extracted.stories };
    const mappings: ImportedStoryMapping[] = extracted.stories.map((story) => ({ documentIndex: 0, sceneId: 21, kind: story.kind, storyId: story.id }));
    const tx = { scene: { findFirst: jest.fn(async () => ({ chapterId: 12 })) } } as unknown as Prisma.TransactionClient;
    return { tx, source, extracted, layout, mappings, conversion: { kind: 'docx', documents: [{ document: source }] }, bodies: [{ sceneId: 21, document: extracted.document }] };
  };
  test('separated body, comments, attribution and story identity attest to the retained graph', async () => {
    const f = fixture(); expect(await verifyImportedGraph(f.tx, 9, f.conversion, f.bodies, f.layout, f.mappings)).toEqual(new Set(f.mappings.map((mapping) => mapping.storyId)));
    expect(f.source.layout.header).toHaveLength(1); expect(f.source.comments).toHaveLength(1); expect(f.bodies[0].document.comments).toHaveLength(0);
  });
  test.each(['body', 'story', 'attribution', 'layout', 'owner', 'mapping'] as const)('rejects altered %s without granting imported provenance', async (altered) => {
    const f = fixture();
    if (altered === 'body') { const paragraph = f.bodies[0].document.blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('fixture'); paragraph.runs[0].text = 'Forged body'; }
    if (altered === 'story') { const paragraph = f.layout.headerFooterStories![0].document.blocks[0]; if (paragraph.type !== 'paragraph') throw new Error('fixture'); paragraph.runs[0].style.bold = true; }
    if (altered === 'attribution') f.layout.headerFooterStories![0].document.comments[0].importedAuthor = 'Forged attribution';
    if (altered === 'layout') f.layout.chapters['12'] = { ...f.layout.chapters['12'], margins: [1, 1, 1, 1] };
    if (altered === 'owner') f.layout.headerFooterStories![0].chapterId = 999;
    if (altered === 'mapping') f.mappings = [];
    await expect(verifyImportedGraph(f.tx, 9, f.conversion, f.bodies, f.layout, f.mappings)).rejects.toMatchObject({ code: 'DOCUMENT_IMPORT_PROVENANCE_INVALID' });
  });
  test('full retained table story overrides compatibility fragments while binding image digest and cell comments', async () => {
    const f = fixture(); const story = documentFromText('Table header', randomUUID); const cell = story.blocks[0]; if (cell.type !== 'paragraph') throw new Error('fixture');
    cell.runs.push({ id: randomUUID(), text: '', style: {}, inlineImage: { assetId: 1, sha256: 'a'.repeat(64), alt: 'Owned drawing', width: 20, height: 20 } });
    story.blocks = [{ type: 'table', id: randomUUID(), widths: [100], rows: [{ id: randomUUID(), cells: [{ id: randomUUID(), paragraphs: [cell] }] }] }];
    story.comments.push({ id: randomUUID(), authorId: 0, authorName: 'Imported reviewer', importedAuthor: 'Imported reviewer', createdAt: '2026-01-02T03:04:05.000Z', text: 'Cell review', resolved: false, anchors: [{ blockId: cell.id, runId: cell.runs[0].id, start: 0, end: 5, sourceText: 'Table' }] });
    const conversion = { ...f.conversion, headerFooterStories: [{ documentIndex: 0, kind: 'header' as const, document: structuredClone(story) }] };
    f.layout.headerFooterStories![0].document = story; cell.runs[1].inlineImage!.assetId = 55;
    expect(await verifyImportedGraph(f.tx, 9, conversion, f.bodies, f.layout, f.mappings)).toEqual(new Set(f.mappings.map((mapping) => mapping.storyId)));
    cell.runs[1].inlineImage!.sha256 = 'b'.repeat(64);
    await expect(verifyImportedGraph(f.tx, 9, conversion, f.bodies, f.layout, f.mappings)).rejects.toMatchObject({ code: 'DOCUMENT_IMPORT_PROVENANCE_INVALID' });
  });
  test('import attests exact named definitions and labels while preserving all owned styles', async () => {
    const f = fixture(); const previous = structuredClone(f.layout);
    previous.styles = { text: { existing: { bold: true } }, paragraph: { existing: { alignment: 'center' } }, labels: { existing: 'Owned style' } };
    const styles = { text: { imported: { italic: true } }, paragraph: { imported: { alignment: 'right' as const } }, labels: { imported: '日本語 display name' } };
    const conversion = { ...f.conversion, styles };
    f.layout.styles = { text: { ...previous.styles.text, ...styles.text }, paragraph: { ...previous.styles.paragraph, ...styles.paragraph }, labels: { ...previous.styles.labels, ...styles.labels } };
    expect(await verifyImportedGraph(f.tx, 9, conversion, f.bodies, f.layout, f.mappings, previous)).toEqual(new Set(f.mappings.map((mapping) => mapping.storyId)));
    f.layout.styles.text.existing = { italic: true };
    await expect(verifyImportedGraph(f.tx, 9, conversion, f.bodies, f.layout, f.mappings, previous)).rejects.toMatchObject({ code: 'DOCUMENT_IMPORT_PROVENANCE_INVALID' });
    f.layout.styles.text.existing = previous.styles.text.existing;
    f.layout.styles.labels!.imported = 'Forged display label';
    await expect(verifyImportedGraph(f.tx, 9, conversion, f.bodies, f.layout, f.mappings, previous)).rejects.toMatchObject({ code: 'DOCUMENT_IMPORT_PROVENANCE_INVALID' });
    f.layout.styles.labels!.imported = styles.labels.imported;
    delete f.layout.styles.paragraph.imported;
    await expect(verifyImportedGraph(f.tx, 9, conversion, f.bodies, f.layout, f.mappings, previous)).rejects.toMatchObject({ code: 'DOCUMENT_IMPORT_PROVENANCE_INVALID' });
  });
});
