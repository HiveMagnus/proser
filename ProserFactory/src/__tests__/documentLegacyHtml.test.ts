import { randomUUID } from 'node:crypto';
import { convertSupportedLegacyHtml } from '@/documents/legacyHtml';
import { previewLegacyHtmlScene, commitLegacyHtmlScene } from '@/documents/legacyHtmlBackfill';
import { projectDocument } from '@/documents/model';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';

describe('bounded original-preserving supported legacy HTML conversion',()=>{
 test('preserves Unicode inline styles, headings, lists and rectangular tables deterministically',()=>{
  const raw='<h2 style="text-align:center">Heading 😀</h2><p><strong> Bold é </strong><em>italic</em><span style="font-family:Georgia;font-size:18px;color:#112233"> color</span><br>尾&nbsp;word <a href="https://example.com/path">safe</a></p><ul><li>item</li></ul><table><tr><td><p>one</p><p>two</p></td><td>cell</td></tr></table>';
  const converted=convertSupportedLegacyHtml(raw,'fixture');expect(convertSupportedLegacyHtml(raw,'fixture')).toEqual(converted);
  expect(projectDocument(converted.document).text).toBe('Heading 😀\n\n Bold é italic color\n尾\u00a0word safe\n\nitem\n\none\n\ntwo\tcell');
  const paragraph=converted.document.blocks[1];if(paragraph.type!=='paragraph')throw new Error('fixture');expect(paragraph.runs[0].style.bold).toBe(true);expect(paragraph.runs[1].style.italic).toBe(true);expect(paragraph.runs[2].style).toMatchObject({font:'Georgia',size:18,color:'#112233'});
  expect(converted.fidelity.losses).toEqual([]);
 });
 test('reports unsupported CSS values and preserves inline important precedence rather than silently flattening them',()=>{
  const converted=convertSupportedLegacyHtml('<p class="lost-style" style="text-align:start;break-before:left"><span style="font-weight:lighter;font-style:oblique;text-decoration:overline;font-family:Georgia,serif">lost</span><span style="font-weight:bold!important;font-weight:normal"> retained</span></p>','css-fixture');
  const paragraph=converted.document.blocks[0];if(paragraph.type!=='paragraph')throw new Error('fixture');
  expect(paragraph.runs[0].style).toMatchObject({underline:false,strikeout:false});expect(paragraph.runs[0].style.bold).toBeUndefined();expect(paragraph.runs[1].style.bold).toBe(true);
  expect(converted.fidelity.losses).toEqual(expect.arrayContaining(['Stylesheet class formatting is unavailable; class references were removed.','Unsupported relative font weight removed.','Unsupported font style removed.','Unsupported text decoration reduced to underline/strikeout.','Unsupported font family or fallback list removed.','Unsupported paragraph alignment removed.','Unsupported paragraph break before removed.','CSS important priority is not retained outside the converted inline value.']));
 });
 test('reports unsafe content and external images without fetching or interpreting them',()=>{
  const converted=convertSupportedLegacyHtml('<p onclick="doEvil()">safe<script>danger()</script><a href="javascript:danger()">link</a><img src="https://example.invalid/image.png" alt="picture"></p>','fixture');
  expect(projectDocument(converted.document).text).toBe('safelinkpicture');expect(converted.fidelity.externalResources).toEqual(['https://example.invalid/image.png']);expect(converted.fidelity.losses.length).toBe(4);
  expect(()=>convertSupportedLegacyHtml('<!DOCTYPE x [<!ENTITY a "boom">]><p>&a;</p>','fixture')).toThrow('DTD');
  expect(()=>convertSupportedLegacyHtml('<table><tr><td colspan="2">merged</td></tr></table>','fixture')).toThrow('Merged');
  expect(()=>convertSupportedLegacyHtml('<p><svg>ambiguous</svg></p>','fixture')).toThrow('Unsupported inline');
  expect(()=>convertSupportedLegacyHtml('<p>'.repeat(300)+'deep'+'</p>'.repeat(300),'fixture')).toThrow();
 });
 const db=()=>databaseService.client;let userId:number;let bookId:number;let sceneId:number;
 const raw='<p><strong> Preserved 😀é </strong><img src="https://example.invalid/not-fetched.png" alt="image"></p>';
 beforeAll(async()=>{userId=(await db().user.create({data:{githubId:`html-${randomUUID()}`,username:'HTML fixture'}})).id;});
 beforeEach(async()=>{const book=await db().book.create({data:{userId,title:'HTML fixture',acts:{create:{actNumber:1,chapters:{create:{chapterNumber:1,scenes:{create:{sceneNumber:1,prose:raw}}}}}}},include:{acts:{include:{chapters:{include:{scenes:true}}}}}});bookId=book.id;sceneId=book.acts[0].chapters[0].scenes[0].id;await documentService.initialize(userId,bookId);});
 afterEach(async()=>{await db().documentImportPreview.deleteMany({where:{bookId}});await db().documentImportOriginal.deleteMany({where:{bookId}});await db().documentLegacyRevisionMapping.deleteMany({where:{bookId}});await db().documentOperation.deleteMany({where:{bookId}});await db().bookDocumentHead.deleteMany({where:{bookId}});await db().bookDocumentRevision.deleteMany({where:{bookId}});await db().bookDocumentScopeRevision.deleteMany({where:{bookId}});await db().sceneDocumentRevision.deleteMany({where:{bookId}});await db().book.delete({where:{id:bookId}});});
 afterAll(async()=>{await db().user.delete({where:{id:userId}});});
 test('preview retains exact bytes, consent commits supported formatting once, and reload preserves it',async()=>{
  const before=await documentService.read(userId,bookId,sceneId);const preview=await previewLegacyHtmlScene(userId,bookId,sceneId);
  expect(Buffer.from((await db().documentImportOriginal.findUniqueOrThrow({where:{id:preview.originalId}})).bytes).toString('utf8')).toBe(raw);
  expect((await documentService.read(userId,bookId,sceneId)).revisionId).toBe(before.revisionId);
  const input={operationId:randomUUID(),expectedRevisionId:before.bookRevisionId,consentReportHash:preview.reportHash};
  await expect(commitLegacyHtmlScene(userId,bookId,preview.previewId,{...input,consentReportHash:'0'.repeat(64)})).rejects.toMatchObject({code:'DOCUMENT_IMPORT_CONSENT_REQUIRED'});
  const committed=await commitLegacyHtmlScene(userId,bookId,preview.previewId,input);expect(await commitLegacyHtmlScene(userId,bookId,preview.previewId,input)).toEqual(committed);
  const saved=await documentService.read(userId,bookId,sceneId);expect(saved.document).toEqual(preview.document);expect(saved.projection.text).toBe(' Preserved 😀é image');
  expect((await db().sceneDocumentRevision.findUniqueOrThrow({where:{id:before.revisionId}})).originalProse).toBe(raw);
 });
 test('formatting changed after preview prevents application and preserves original evidence',async()=>{
  const before=await documentService.read(userId,bookId,sceneId);const preview=await previewLegacyHtmlScene(userId,bookId,sceneId);
  const paragraph=before.document.blocks[0];if(paragraph.type!=='paragraph')throw new Error('fixture');paragraph.runs[0].style.italic=true;
  await documentService.commit(userId,bookId,{schemaVersion:1,operationId:randomUUID(),expectedRevisionId:before.bookRevisionId,scenes:[{sceneId,expectedRevisionId:before.revisionId,document:before.document}]});
  await expect(commitLegacyHtmlScene(userId,bookId,preview.previewId,{operationId:randomUUID(),expectedRevisionId:before.bookRevisionId,consentReportHash:preview.reportHash})).rejects.toMatchObject({status:412});
  await expect(previewLegacyHtmlScene(userId,bookId,sceneId)).rejects.toMatchObject({code:'DOCUMENT_LEGACY_HTML_AMBIGUOUS'});
  expect(await db().documentImportOriginal.count({where:{bookId}})).toBe(1);
 });
});
