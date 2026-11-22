import { randomUUID } from 'node:crypto';
import { documentFromText, paragraphGroups, paragraphStyle, projectDocument, resolveChange, type DocumentChange, type DocumentParagraph } from '@/documents/model';
import { validateDocument } from '@/documents/validation';
import { frozenTarget, verifyTargets } from '@/documents/targets';

const attribution = { authorId: 1, authorName: 'Author', createdAt: '2026-10-05T00:00:00.000Z', status: 'pending' as const, origin: 'manual' as const };
function boundary(kind: 'paragraphSplit' | 'paragraphJoin') {
  const document = documentFromText('A 😀\n\né passage.', randomUUID);
  const [left, right] = document.blocks as DocumentParagraph[];
  const change: DocumentChange = { ...attribution, id: randomUUID(), kind, targetRunIds: [], targetBlockIds: [left.id, right.id] };
  left.boundaryChangeId = change.id; document.changes.push(change);
  return { document, left, right, change };
}
describe('native paragraph review projections', () => {
  test.each(['paragraphSplit', 'paragraphJoin'] as const)('%s projects the paragraph mark and preserves physical Unicode spans after resolution', (kind) => {
    const { document, left, right, change } = boundary(kind); validateDocument(document);
    const split = kind === 'paragraphSplit';
    expect(projectDocument(document, 'final').text).toBe(split ? 'A 😀\n\né passage.' : 'A 😀é passage.');
    expect(projectDocument(document, 'original').text).toBe(split ? 'A 😀é passage.' : 'A 😀\n\né passage.');
    expect(projectDocument(document, 'markup').text).toBe('A 😀\n\né passage.');
    expect(paragraphGroups([left, right], document.changes, 'final').length).toBe(split ? 2 : 1);
    for (const decision of ['accepted', 'rejected'] as const) {
      const resolved = validateDocument(resolveChange(document, change.id, decision));
      const visible = decision === 'accepted' ? split : !split;
      for (const view of ['original', 'final', 'markup'] as const) expect(projectDocument(resolved, view).text).toBe(visible ? 'A 😀\n\né passage.' : 'A 😀é passage.');
      expect(resolved.blocks.map((block) => block.id)).toEqual([left.id, right.id]);
      expect(projectDocument(resolved).spans.filter((span) => span.editable).map((span) => [span.blockId, span.runId])).toEqual([[left.id, left.runs[0].id], [right.id, right.runs[0].id]]);
    }
  });
  test('paragraph property revisions retain original properties and reject overlapping proposed snapshots', () => {
    const document = documentFromText('A styled paragraph.', randomUUID); const block = document.blocks[0] as DocumentParagraph;
    block.style = { alignment: 'center', heading: 2, before: 12, keepWithNext: true };
    const change: DocumentChange = { ...attribution, id: randomUUID(), kind: 'paragraphFormat', targetRunIds: [], targetBlockIds: [block.id], beforeParagraphStyle: { alignment: 'left' }, afterParagraphStyle: { ...block.style } };
    document.changes.push(change); validateDocument(document);
    expect(paragraphStyle(block, document.changes, 'original')).toEqual({ alignment: 'left' });
    expect(paragraphStyle(block, document.changes, 'final')).toEqual(block.style);
    const rejected = validateDocument(resolveChange(document, change.id, 'rejected'));
    expect((rejected.blocks[0] as DocumentParagraph).style).toEqual({ alignment: 'left' });
    document.changes.push({ ...change, id: randomUUID() }); expect(() => validateDocument(document)).toThrow('Overlapping');
    document.changes.pop(); block.style.alignment = 'right'; expect(() => validateDocument(document)).toThrow('proposed properties');
  });
  test('paragraph marks cannot cross protected objects, table cells, stories or lose their linked targets', () => {
    const { document, left, right, change } = boundary('paragraphJoin');
    document.blocks.splice(1, 0, { type: 'pageBreak', id: randomUUID() }); expect(() => validateDocument(document)).toThrow('same container');
    document.blocks.splice(1, 1); document.blocks.pop();
    document.blocks.push({ type: 'table', id: randomUUID(), widths: [100], rows: [{ id: randomUUID(), cells: [{ id: randomUUID(), paragraphs: [right] }] }] });
    expect(() => validateDocument(document)).toThrow('same container');
    document.blocks.pop(); document.blocks.push(right); delete left.boundaryChangeId; expect(() => validateDocument(document)).toThrow('linked adjacent');
    left.boundaryChangeId = change.id; document.changes = []; expect(() => validateDocument(document)).toThrow('Missing paragraph mark');
  });
  test('table-cell paragraph marks use the same projection without joining other cells', () => {
    const { document, left, right } = boundary('paragraphJoin');
    const other = documentFromText('Other cell.', randomUUID).blocks[0] as DocumentParagraph;
    document.blocks = [{ type: 'table', id: randomUUID(), widths: [100, 100], rows: [{ id: randomUUID(), cells: [{ id: randomUUID(), paragraphs: [left, right] }, { id: randomUUID(), paragraphs: [other] }] }] }];
    validateDocument(document); expect(projectDocument(document).text).toBe('A 😀é passage.\tOther cell.');
  });
  test('pending paragraph review blocks exact AI targets and resolved review changes invalidate old targets', () => {
    const { document, left, right, change } = boundary('paragraphJoin');
    const target = frozenTarget(document, { blockId: right.id, from: 0, to: right.runs[0].text.length, sourceText: right.runs[0].text });
    expect(target.editable).toBe(false);
    const resolved = resolveChange(document, change.id, 'accepted');
    expect(() => verifyTargets(resolved, [target])).toThrow('changed');
    expect(frozenTarget(resolved, target).editable).toBe(true);
    expect((resolved.blocks[0] as DocumentParagraph).id).toBe(left.id);
  });
});
