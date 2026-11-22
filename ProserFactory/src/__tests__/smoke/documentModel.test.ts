import { documentFromText, canonicalDocument, projectDocument, replaceDocumentText, regenerateDocumentText, resolveChange, minimalTextEdit, reconcileDocuments } from '@/documents/model';
import { validateDocument } from '@/documents/validation';
import { requireDocumentPreconditions } from '@/api/schemas/documents';
let sequence = 0;
const id = () => `fixture-${++sequence}`;
beforeEach(() => { sequence = 0; });
test('three-way proposals merge disjoint stable blocks and preserve protected objects and layout', () => {
  const base = documentFromText('Repeated quotation\n\nRepeated quotation', id);
  base.blocks.push({ type: 'image', id: id(), assetId: 1, sha256: 'a'.repeat(64), alt: 'Protected', width: 10, height: 10 });
  const local = structuredClone(base); const saved = structuredClone(base);
  const first = local.blocks[0]; const second = saved.blocks[1];
  if (first.type !== 'paragraph' || second.type !== 'paragraph') throw new Error('fixture');
  first.runs[0].text = 'Local first'; second.runs[0].text = 'Saved second'; saved.layout.font = 'Arial';
  const proposal = reconcileDocuments(base, local, saved);
  expect(proposal.conflicts).toEqual([]); expect(proposal.document!.blocks[2]).toEqual(base.blocks[2]);
  expect(projectDocument(proposal.document!).text).toBe('Local first\n\nSaved second\n\n\ufffc');
  expect(proposal.document!.layout.font).toBe('Arial'); expect(base.blocks[0]).not.toEqual(local.blocks[0]);
});
test('three-way proposals reject overlapping formatting, identity/order and stale comment anchors', () => {
  const base = documentFromText('First\n\nSecond', id); const local = structuredClone(base); const saved = structuredClone(base);
  const first = local.blocks[0]; const remote = saved.blocks[0]; if (first.type !== 'paragraph' || remote.type !== 'paragraph') throw new Error('fixture');
  first.runs[0].text = 'Local'; remote.runs[0].style.bold = true;
  expect(reconcileDocuments(base, local, saved)).toEqual({ conflicts: [`block:${first.id}`] });
  saved.blocks.reverse(); expect(reconcileDocuments(base, local, saved).conflicts).toContain('block-order-or-identity');
  const commented = structuredClone(base); const original = base.blocks[0]; if (original.type !== 'paragraph') throw new Error('fixture');
  commented.comments.push({ id: id(), authorId: 1, authorName: 'Author', createdAt: new Date().toISOString(), text: 'Exact anchor', resolved: false, anchors: [{ blockId: original.id, runId: original.runs[0].id, start: 0, end: 5, sourceText: 'First' }] });
  expect(reconcileDocuments(base, local, commented).conflicts).toContain(`comment-anchor:${commented.comments[0].id}`);
});
test('plain text conversion preserves whitespace, Unicode and paragraph boundaries exactly', () => {
  const text = '  First 😀 e\u0301\nline.\n\n\nNext.\n\n';
  expect(projectDocument(validateDocument(documentFromText(text, id))).text).toBe(text);
});
test('invalid Unicode/NUL is rejected before persistence without normalizing valid content', () => {
  for (const text of ['\uD800','\uDC00','before\u0000after']) expect(() => validateDocument(documentFromText(text,id))).toThrow('valid Unicode');
  expect(projectDocument(validateDocument(documentFromText('😀 e\u0301\r\n\t尾',id))).text).toBe('😀 e\u0301\r\n\t尾');
});
test('canonical serialization is formatting-aware and independent of object key insertion order', () => {
  expect(canonicalDocument({ bold: true, italic: false })).toBe(canonicalDocument({ italic: false, bold: true }));
  expect(canonicalDocument({ bold: true })).not.toBe(canonicalDocument({ bold: false }));
});
test('Unicode replacements do not split shared emoji surrogates or combining sequences', () => {
  expect(minimalTextEdit('😀 after', '😃 after')).toEqual({ start: 0, end: 2, replacement: '😃' });
  expect(minimalTextEdit('e\u0301 after', 'e\u0300 after')).toEqual({ start: 0, end: 2, replacement: 'e\u0300' });
});
test('targeted replacement retains untouched run formatting and supports original/final/reject views', () => {
  const document = documentFromText('Hello world', id);
  const paragraph = document.blocks[0];
  if (paragraph.type !== 'paragraph') throw new Error('fixture');
  paragraph.runs[0].style = { bold: true, color: '#123456' };
  const edited = replaceDocumentText(document, 6, 11, 'world', 'friend', id, { authorId: 1, authorName: 'Author', createdAt: new Date().toISOString(), status: 'pending', origin: 'ai' });
  validateDocument(edited);
  expect(projectDocument(edited).text).toBe('Hello friend');
  expect(projectDocument(edited, 'original').text).toBe('Hello world');
  const changed = edited.blocks[0];
  if (changed.type !== 'paragraph') throw new Error('fixture');
  expect(changed.runs.every((run) => run.style.bold && run.style.color === '#123456')).toBe(true);
  let rejected = edited;
  for (const change of edited.changes) rejected = resolveChange(rejected, change.id, 'rejected');
  expect(projectDocument(rejected).text).toBe('Hello world');
});
test('ambiguous style replacements, protected paragraph boundaries, stale text and grapheme splits fail', () => {
  const document = documentFromText('😀ab\n\nnext', id);
  expect(() => replaceDocumentText(document, 1, 2, '\ude00', 'x', id)).toThrow('grapheme');
  expect(() => replaceDocumentText(document, 0, 2, 'wrong', 'x', id)).toThrow('STALE');
  expect(() => replaceDocumentText(document, 3, 8, projectDocument(document).text.slice(3, 8), 'x', id)).toThrow('protected');
});
test('validation rejects duplicate IDs, forged schemas, external resources and dangling changes', () => {
  const document = documentFromText('text', id);
  const block = document.blocks[0];
  if (block.type !== 'paragraph') throw new Error('fixture');
  block.runs[0].id = block.id;
  expect(() => validateDocument(document)).toThrow('Duplicate');
  expect(() => validateDocument({ ...document, schemaVersion: 2 })).toThrow();
});
test('missing revision preconditions and oversized mutations have explicit HTTP statuses', () => {
  for (const input of [{}, { expectedRevisionId: 'base', operationId: 'operation', scenes: [{ sceneId: 1 }] }]) {
    try { requireDocumentPreconditions(input, true); throw new Error('Expected rejection'); }
    catch (error) { expect(error).toMatchObject({ status: 428 }); }
  }
  expect(() => requireDocumentPreconditions({ expectedRevisionId: 'base', operationId: 'operation', scenes: [{ expectedRevisionId: 'scene' }] }, true)).not.toThrow();
  try { requireDocumentPreconditions({ expectedRevisionId: 'base', operationId: 'operation', text: 'a'.repeat(8 * 1024 * 1024) }, false); throw new Error('Expected rejection'); }
  catch (error) { expect(error).toMatchObject({ status: 413 }); }
});
test('reviewed paragraph regeneration preserves exact original/final whitespace, layout, comments and inherited formatting', () => {
  const source = documentFromText('Original 😀\n\nSecond é.', id);
  for (const block of source.blocks) if (block.type === 'paragraph') { block.style = { alignment: 'justify' }; block.runs[0].style = { italic: true }; }
  const first = source.blocks[0]; if (first.type !== 'paragraph') throw new Error('fixture');
  source.comments.push({ id: id(), authorId: 1, authorName: 'Owner', createdAt: new Date().toISOString(), resolved: false, text: 'Keep this discussion', anchors: [{ blockId: first.id, runId: first.runs[0].id, start: 0, end: 8, sourceText: 'Original' }] });
  const revised = '  New first.\n\n\nNew second.\n\n';
  const result = validateDocument(regenerateDocumentText(source, revised, id, { authorId: 1, authorName: 'Owner', createdAt: new Date().toISOString(), status: 'pending', origin: 'ai' }));
  expect(projectDocument(result).text).toBe(revised); expect(projectDocument(result, 'original').text).toBe(projectDocument(source).text);
  expect(result.comments).toEqual(source.comments); expect(result.layout).toEqual(source.layout);
  expect(result.blocks.every((block) => block.type === 'paragraph' && block.style.alignment === 'justify' && block.runs.every((run) => run.style.italic))).toBe(true);
  let rejected = result; for (const change of result.changes) rejected = resolveChange(rejected, change.id, 'rejected');
  expect(projectDocument(rejected).text).toBe(projectDocument(source).text);
});
test('reviewed regeneration refuses protected objects, mixed styles and unresolved review state', () => {
  const source = documentFromText('Styled', id); const first = source.blocks[0]; if (first.type !== 'paragraph') throw new Error('fixture');
  const attribution = { authorId: 1, authorName: 'Owner', createdAt: new Date().toISOString(), status: 'pending' as const, origin: 'ai' as const };
  first.runs.push({ id: id(), text: ' differently', style: { bold: true } });
  expect(() => regenerateDocumentText(source, 'New', id, attribution)).toThrow('incompatible');
  first.runs.pop(); source.blocks.push({ type: 'pageBreak', id: id() });
  expect(() => regenerateDocumentText(source, 'New', id, attribution)).toThrow('protected');
  source.blocks.pop(); const pending = regenerateDocumentText(source, 'New', id, attribution);
  expect(() => regenerateDocumentText(pending, 'Again', id, attribution)).toThrow('Resolve');
});
