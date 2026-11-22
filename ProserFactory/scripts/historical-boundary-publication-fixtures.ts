import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { documentFromText, canonicalDocument, projectDocument, resolveChange } from '../src/documents/model';
import { stampDocumentReview } from '../src/documents/reviewAttribution';
import { publicationDocx } from '../src/documents/publicationDocx';
import { publicationEpub, publicationPdf, reviewSidecar, type PublicationInput } from '../src/documents/publicationRender';
const target = process.argv[2];
if (!target || !path.isAbsolute(target)) throw new Error('Supply an isolated absolute fixture directory.');
async function main() {
  await mkdir(target, { recursive: true });
  const before = documentFromText('Old boundary left.\n\nOld boundary right.', randomUUID);
  before.layout.font = 'Liberation Serif';
  const [left, right] = before.blocks;
  if (left.type !== 'paragraph' || right.type !== 'paragraph') throw new Error('fixture');
  const oldId = randomUUID(), newId = randomUUID();
  left.boundaryChangeId = oldId;
  before.changes = [{ id: oldId, kind: 'paragraphSplit', status: 'accepted', origin: 'import', authorId: 4, authorName: 'Imported editor', importedAuthor: 'Historical Word reviewer', createdAt: '2020-01-01T00:00:00.000Z', targetRunIds: [], targetBlockIds: [left.id, right.id], resolutionHistory: [{ operationId: randomUUID(), actorId: 5, actorName: 'Prior reviewer', createdAt: '2020-01-02T00:00:00.000Z', decision: 'accepted', origin: 'manual', phase: 'resolved', sourceKind: 'scene', sourceSceneId: 1, sourceSceneRevisionId: randomUUID(), sourceBookRevisionId: randomUUID(), sourceContentHash: 'a'.repeat(64) }] }];
  const document = structuredClone(before), currentLeft = document.blocks[0], currentRight = document.blocks[1];
  if (currentLeft.type !== 'paragraph' || currentRight.type !== 'paragraph') throw new Error('fixture');
  currentRight.id = randomUUID(); currentLeft.boundaryChangeId = newId;
  document.changes.push({ id: newId, kind: 'paragraphJoin', status: 'pending', origin: 'manual', authorId: 8, authorName: 'Current editor', createdAt: '2026-10-06T00:00:00.000Z', targetRunIds: [], targetBlockIds: [currentLeft.id, currentRight.id] });
  stampDocumentReview(document, before, { id: 8, name: 'Current editor' }, 'manual', false, { operationId: randomUUID(), sourceKind: 'scene', sourceSceneId: 1, sourceSceneRevisionId: randomUUID(), sourceBookRevisionId: randomUUID(), sourceContentHash: 'b'.repeat(64) });
  const revisionId = randomUUID(), retainedHash = createHash('sha256').update(canonicalDocument(document)).digest('hex');
  const evidence: unknown[] = [];
  for (const name of ['final', 'original', 'retain-review', 'accepted', 'rejected'] as const) {
    const body = name === 'accepted' || name === 'rejected' ? resolveChange(document, newId, name) : document;
    const mode = name === 'accepted' || name === 'rejected' ? 'final' : name;
    const input: PublicationInput = { title: 'Historical boundary fixture', author: 'Fixture', revisionId, sections: [{ id: 'historical-scene', title: 'Scene', startsChapter: false, document: body }], assets: new Map() };
    const docx = await publicationDocx(input, mode), epub = await publicationEpub(input, mode), pdf = await publicationPdf(input, mode);
    await writeFile(path.join(target, name + '.docx'), docx); await writeFile(path.join(target, name + '.epub'), epub); await writeFile(path.join(target, name + '.pdf'), pdf.bytes);
    await writeFile(path.join(target, name + '.review.json'), JSON.stringify(reviewSidecar(input), null, 2));
    await writeFile(path.join(target, name + '.renderer.json'), JSON.stringify(pdf, (key, value: unknown) => key === 'bytes' ? undefined : value, 2));
    evidence.push({ name, mode, projection: name === 'original' ? 'original' : 'final', text: projectDocument(body, name === 'original' ? 'original' : 'final').text, docxSha256: createHash('sha256').update(docx).digest('hex'), pdfSha256: createHash('sha256').update(pdf.bytes).digest('hex'), historicalChangeId: oldId, currentChangeId: newId });
  }
  if (createHash('sha256').update(canonicalDocument(document)).digest('hex') !== retainedHash) throw new Error('Publication mutated source.');
  await writeFile(path.join(target, 'source.json'), JSON.stringify(document, null, 2));
  await writeFile(path.join(target, 'evidence.json'), JSON.stringify({ sourceHash: retainedHash, modes: evidence, microsoftWord: 'unverified' }, null, 2));
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
