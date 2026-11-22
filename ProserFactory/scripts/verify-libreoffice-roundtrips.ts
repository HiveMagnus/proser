import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { convertDocx, type DocxConversion } from '../src/documents/docxImport';
import { canonicalDocument, projectDocument } from '../src/documents/model';
import { DocumentError } from '../src/documents/errors';
import { publicationDocx } from '../src/documents/publicationDocx';
import { validateDocxPackage } from '../src/documents/packageValidation';
const [fixtureRoot, returnedRoot, outputRoot] = process.argv.slice(2);
if (![fixtureRoot, returnedRoot, outputRoot].every((value) => value && path.isAbsolute(value))) throw new Error('Supply absolute synthetic fixture, LibreOffice return and evidence directories.');
const corpus = [
  ['base', 'retain-review.docx'], ['comments', 'native-comments/retain-review.docx'],
  ['split', 'native-paragraphs/paragraphSplit-retain-review.docx'], ['join', 'native-paragraphs/paragraphJoin-retain-review.docx'],
  ['paragraph-format', 'native-paragraphs/paragraphFormat-retain-review.docx'], ['stories', 'owned-stories/retain-review.docx'],
  ['theme', 'word-themes/retain-review.docx'], ['empty-font', 'empty-line-fonts/retain-review.docx'],
];
const snapshot = (value: DocxConversion) => ({
  final: value.documents.map((document) => projectDocument(document).text).join('\n\n'),
  original: value.documents.map((document) => projectDocument(document, 'original').text).join('\n\n'),
  changes: value.documents.flatMap((document) => document.changes).map((change) => ({ kind: change.kind, author: change.importedAuthor, date: change.createdAt })),
  comments: value.documents.flatMap((document) => document.comments).map((comment) => ({ author: comment.importedAuthor, text: comment.text, anchors: comment.anchors.map((anchor) => anchor.sourceText).join('') })),
  stories: value.headerFooterStories.map((story) => ({ kind: story.kind, documentIndex: story.documentIndex,
    final: projectDocument(story.document).text, original: projectDocument(story.document, 'original').text,
    changes: story.document.changes.map((change) => ({ kind: change.kind, author: change.importedAuthor, date: change.createdAt })) })),
});
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function main() {
  await mkdir(outputRoot, { recursive: true });
  const results: unknown[] = [];
  for (const [name, file] of corpus) {
    const sourceBytes = await readFile(path.join(fixtureRoot, file)), returnedBytes = await readFile(path.join(returnedRoot, name, path.basename(file)));
    const before = snapshot(await convertDocx(sourceBytes));
    if (name === 'empty-font') {
      try { await convertDocx(returnedBytes); throw new Error('Malformed duplicate-property review was silently accepted.'); }
      catch (error) { if (!(error instanceof DocumentError) || error.code !== 'DOCUMENT_IMPORT_RUN_PROPERTIES_AMBIGUOUS') throw error; }
      results.push({ name, sourceSha256: hash(sourceBytes), returnedSha256: hash(returnedBytes), result: 'rejected-ambiguous-external-source', sourceReview: before.changes, originalPreservationRequired: true });
      continue;
    }
    const conversion = await convertDocx(returnedBytes), after = snapshot(conversion);
    const checks = Object.fromEntries(Object.keys(before).map((key) => [key, canonicalDocument(before[key as keyof typeof before]) === canonicalDocument(after[key as keyof typeof after])]));
    if (Object.values(checks).some((passed) => !passed)) throw new Error(`LibreOffice semantic round trip failed: ${name} ${JSON.stringify(checks)}`);
    const rebuilt = await publicationDocx({ title: 'Independent Word exchange fixture', author: 'Fixture', revisionId: '11111111-1111-4111-8111-111111111111', styles: conversion.styles,
      sections: conversion.documents.map((document, index) => ({ id: String(index), title: 'Scene', startsChapter: false, document,
        headerStory: (() => { const story = conversion.headerFooterStories.find((entry) => entry.documentIndex === index && entry.kind === 'header'); return story ? { id: 'header-' + index, document: story.document } : undefined; })(),
        footerStory: (() => { const story = conversion.headerFooterStories.find((entry) => entry.documentIndex === index && entry.kind === 'footer'); return story ? { id: 'footer-' + index, document: story.document } : undefined; })() })),
      assets: new Map(conversion.assets.map((asset) => [asset.placeholderId, { bytes: Buffer.from(asset.bytesBase64, 'base64'), mediaType: asset.mediaType }])) }, 'retain-review');
    await validateDocxPackage(rebuilt); await writeFile(path.join(outputRoot, name + '.docx'), rebuilt);
    results.push({ name, sourceSha256: hash(sourceBytes), returnedSha256: hash(returnedBytes), rebuiltSha256: hash(rebuilt), result: 'supported-semantics-preserved-with-disclosed-source-losses', checks, losses: conversion.losses,
      sourceReview: before.changes, fontAssociationAndSourceSchemaFidelity: 'reduced-see-losses' });
  }
  await writeFile(path.join(outputRoot, 'semantic-roundtrips.json'), JSON.stringify({ schemaVersion: 1, microsoftWord: 'unverified', scope: 'Exact final/original body and story text, native revision kinds/attribution/dates and classic comment text/attribution/source ranges; source schema/font associations and ambiguous external review are explicitly reduced or rejected.', results }, null, 2));
  console.log('Seven supported native semantic round trips passed; one ambiguous LibreOffice source rejected with original preservation required. Independent source/return/rebuilt schema validation remains separate.');
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
