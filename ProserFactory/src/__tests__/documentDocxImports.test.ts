import { randomUUID } from 'node:crypto';
import {createRequire} from 'node:module';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { documentFromText, projectDocument } from '@/documents/model';
import { exportStructuredDocx } from '@/documents/docxExport';
import { convertDocx } from '@/documents/docxImport';
import {
  preserveDocxOriginal,
  prepareDocxImport,
  commitDocxImport,
  readDocxImportPreview,
} from '@/documents/docxImports';
import { readImportOriginal } from '@/documents/imports';
import { createZipBuffer } from '@/lib/zipArchive';
import { validateDocxPackage } from '@/documents/packageValidation';
const fixture = () => {
  const document = documentFromText('Imported 😀 styled prose.', randomUUID);
  document.layout = {
    ...document.layout,
    font: 'Liberation Mono',
    width: 612,
    height: 792,
    margins: [45, 50, 55, 60],
  };
  const paragraph = document.blocks[0];
  if (paragraph.type !== 'paragraph') throw new Error('fixture');
  paragraph.style = { heading: 1, alignment: 'center' };
  const run = paragraph.runs[0];
  run.style = { bold: true, font: 'Liberation Serif' };
  const changeId = randomUUID();
  run.changeId = changeId;
  document.changes = [
    {
      id: changeId,
      kind: 'insertion',
      authorId: 123,
      authorName: 'Word author',
      createdAt: '2026-01-02T03:04:05.000Z',
      status: 'pending',
      origin: 'import',
      targetRunIds: [run.id],
    },
  ];
  document.comments = [
    {
      id: randomUUID(),
      authorId: 123,
      authorName: 'Comment author',
      createdAt: '2026-01-02T03:04:05.000Z',
      text: 'Classic anchored comment.',
      resolved: false,
      anchors: [
        {
          blockId: paragraph.id,
          runId: run.id,
          start: 0,
          end: 8,
          sourceText: run.text.slice(0, 8),
        },
      ],
    },
  ];
  return document;
};
describe('bounded DOCX conversion', () => {
  test('retains native inserted text, run formatting and classic anchored imported comments', async () => {
    const conversion = await convertDocx(await exportStructuredDocx(fixture(), 'retain-review'));
    const document = conversion.documents[0];
    expect(projectDocument(document).text).toBe('Imported 😀 styled prose.');
    expect(projectDocument(document, 'original').text).toBe('');
    expect(document.changes[0]).toMatchObject({
      kind: 'insertion',
      origin: 'import',
      importedAuthor: 'Word author',
      createdAt: '2026-01-02T03:04:05.000Z',
    });
    expect(document.comments[0]).toMatchObject({
      importedAuthor: 'Comment author',
      text: 'Classic anchored comment.',
    });
    expect(document.comments[0].anchors.map((anchor) => anchor.sourceText).join('')).toBe(
      'Imported',
    );
    const paragraph = document.blocks[0];
    expect(paragraph.type === 'paragraph' && paragraph.runs[0].style.bold).toBe(true);
  });
  test('imports native paragraph formatting revisions before commit', async () => {
    const files = await validateDocxPackage(await exportStructuredDocx(fixture(), 'retain-review'));
    files.set(
      'word/document.xml',
      Buffer.from(
        files
          .get('word/document.xml')!
          .toString()
          .replace(
            '<w:pPr>',
            '<w:pPr><w:pPrChange w:id="20" w:author="Editor"><w:pPr/></w:pPrChange>',
          ),
      ),
    );
    const bytes = await createZipBuffer(
      Array.from(files, ([name, content]) => ({ name, content })),
    );
    const conversion = await convertDocx(bytes);
    expect(conversion.losses.some((loss) => loss.code === 'pPrChange')).toBe(false);
    expect(conversion.documents[0].changes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'paragraphFormat', importedAuthor: 'Editor', beforeParagraphStyle: {} })]));
  });
  test('section previews retain separate layouts and header stories before hierarchy allocation', async () => {
    const { publicationDocx } = await import('@/documents/publicationDocx');
    const first = fixture(); const second = fixture(); second.layout.margins = [80, 90, 80, 90]; second.layout.header = [{ type: 'paragraph', id: 'second-header', style: {}, runs: [{ id: 'second-header-r', text: 'Second section header', style: {} }] }];
    const bytes = await publicationDocx({title: 'Sections', author:'Fixture', revisionId: randomUUID(), sections:[{id:'one',title:'One',document:first},{id:'two',title:'Two',document:second}],assets:new Map()}, 'final');
    const conversion = await convertDocx(bytes); expect(conversion.documents).toHaveLength(2); expect(conversion.documents[1].layout.margins).toEqual([80,90,80,90]); expect(conversion.documents[1].layout.header[0].runs.map((run)=>run.text).join('')).toBe('Second section header'); expect(conversion.losses.some((loss)=>loss.code==='MULTIPLE_SECTIONS')).toBe(false);
  });
  test('rejects unsafe ZIP paths, DTD/entity expansion and malformed XML', async () => {
    const files = await validateDocxPackage(await exportStructuredDocx(fixture(), 'final'));
    files.set(
      'word/document.xml',
      Buffer.from('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><x/>'),
    );
    await expect(
      convertDocx(
        await createZipBuffer(Array.from(files, ([name, content]) => ({ name, content }))),
      ),
    ).rejects.toMatchObject({ code: 'UNSAFE_DOCUMENT_XML' });
    await expect(convertDocx(Buffer.from('not a zip'))).rejects.toMatchObject({
      code: 'INVALID_DOCUMENT_PACKAGE',
    });
  });
});
describe('original-preserving DOCX preview and explicit commit', () => {
  const db = () => databaseService.client;
  let userId: number;
  let otherUserId: number;
  let bookId: number;
  let sceneId: number;
  beforeAll(async () => {
    userId = (
      await db().user.create({
        data: { githubId: `docx-import-${randomUUID()}`, username: 'Authenticated importer' },
      })
    ).id;
    otherUserId = (
      await db().user.create({
        data: { githubId: `docx-other-${randomUUID()}`, username: 'Other importer' },
      })
    ).id;
  });
  beforeEach(async () => {
    const book = await db().book.create({
      data: {
        userId,
        title: 'Existing book',
        acts: {
          create: {
            actNumber: 1,
            chapters: {
              create: {
                chapterNumber: 1,
                scenes: { create: { sceneNumber: 1, prose: 'Existing exact prose.' } },
              },
            },
          },
        },
      },
      include: { acts: { include: { chapters: { include: { scenes: true } } } } },
    });
    bookId = book.id;
    sceneId = book.acts[0].chapters[0].scenes[0].id;
    await documentService.initialize(userId, bookId);
  });
  afterEach(async () => {
    await db().documentPublicationArtifact.deleteMany({where:{bookId}});await db().documentPublication.deleteMany({where:{bookId}});
    await db().documentImportPreview.deleteMany({ where: { bookId } });
    await db().documentImportOriginal.deleteMany({ where: { bookId } });
    await db().documentLegacyRevisionMapping.deleteMany({ where: { bookId } });
    await db().documentOperation.deleteMany({ where: { bookId } });
    await db().bookDocumentHead.deleteMany({ where: { bookId } });
    await db().bookDocumentRevision.deleteMany({ where: { bookId } });
    await db().bookDocumentScopeRevision.deleteMany({ where: { bookId } });
    await db().sceneDocumentRevision.deleteMany({ where: { bookId } });
    await db().book.delete({ where: { id: bookId } });
  });
  afterAll(async () => {
    await db().user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  });
  const prepare = async (input?: Buffer) => {
    const bytes = input ?? await exportStructuredDocx(fixture(), 'retain-review');
    const original = await preserveDocxOriginal(userId, bookId, randomUUID(), bytes);
    const head = await documentService.manifest(userId, bookId);
    const preview = await prepareDocxImport(userId, bookId, {
      operationId: randomUUID(),
      originalId: original.id,
      expectedRevisionId: head.revisionId,
    });
    const request = {
      operationId: randomUUID(),
      expectedRevisionId: head.revisionId,
      expectedScopes: {
        structure: head.scopes!.structure.revisionId,
        canon: head.scopes!.canon.revisionId,
        layout: head.scopes!.layout.revisionId,
      },
      consentReportHash: preview.reportHash,
    };
    return { bytes, original, preview, request };
  };
  test('theme appearance and unsupported associations appear in retained preview before explicit loss consent',async()=>{
    const {fixture:themeFixture}=createRequire(__filename)('../../vendor/canvas-docx-codec/test/theme-fixture.cjs');const {bytes}=await themeFixture();const original=await preserveDocxOriginal(userId,bookId,randomUUID(),bytes);const head=await documentService.manifest(userId,bookId);const preview=await prepareDocxImport(userId,bookId,{originalId:original.id,expectedRevisionId:head.revisionId,operationId:randomUUID()});
    expect((preview.report as unknown as {losses:Array<{code:string}>}).losses.map((loss)=>loss.code)).toEqual(expect.arrayContaining(['THEME_FONT_ASSOCIATION','THEME_COLOR_TRANSFORM_CACHED']));const paragraph=preview.documents[0].blocks[0];expect(paragraph.type==='paragraph'&&paragraph.runs[0].style).toMatchObject({font:'Liberation Mono',color:'#95b3d7'});expect(Buffer.from((await readImportOriginal(userId,bookId,original.id)).bytes)).toEqual(bytes);
    await expect(commitDocxImport(userId,bookId,preview.id,{operationId:randomUUID(),expectedRevisionId:head.revisionId,expectedScopes:{structure:head.scopes!.structure.revisionId,canon:head.scopes!.canon.revisionId,layout:head.scopes!.layout.revisionId},consentReportHash:'a'.repeat(64)})).rejects.toMatchObject({code:'DOCUMENT_IMPORT_CONSENT_REQUIRED'});
  });
  test('preview retains exact original, allocates no hierarchy, then consent commits attributed review once', async () => {
    const old = await documentService.read(userId, bookId, sceneId);
    const prepared = await prepare();
    expect(
      Buffer.from((await readImportOriginal(userId, bookId, prepared.original.id)).bytes),
    ).toEqual(prepared.bytes);
    expect((await documentService.manifest(userId, bookId)).scenes).toHaveLength(1);
    await expect(
      commitDocxImport(userId, bookId, prepared.preview.id, {
        ...prepared.request,
        consentReportHash: undefined,
      }),
    ).rejects.toMatchObject({ code: 'DOCUMENT_IMPORT_CONSENT_REQUIRED' });
    const receipt = await commitDocxImport(userId, bookId, prepared.preview.id, prepared.request);
    const importedId = receipt.result.hierarchy.acts[0].chapters[0].sceneIds[0];
    const body = await documentService.read(userId, bookId, importedId);
    expect(body.document.changes[0]).toMatchObject({
      authorId: userId,
      authorName: 'Authenticated importer',
      importedAuthor: 'Word author',
      origin: 'import',
      createdAt: '2026-01-02T03:04:05.000Z',
    });
    expect(body.document.comments[0]).toMatchObject({
      authorId: userId,
      importedAuthor: 'Comment author',
    });
    const savedLayout = (await documentService.scope(userId, bookId, 'layout')).content.chapters[
      String(receipt.result.hierarchy.acts[0].chapters[0].id)
    ];
    expect(savedLayout).toMatchObject({
      font: 'Liberation Mono',
      width: 612,
      height: 792,
      margins: [45, 50, 55, 60],
    });
    expect((await documentService.read(userId, bookId, sceneId)).document).toEqual(old.document);
    expect(await commitDocxImport(userId, bookId, prepared.preview.id, prepared.request)).toEqual(
      receipt,
    );
    expect((await documentService.manifest(userId, bookId)).scenes).toHaveLength(2);
  });
  test('committed inline assets are remapped to owned immutable image records in body and header', async () => {
    const { createHash } = await import('node:crypto'); const { imagesOf } = await import('@/documents/model');
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64'); const sha256 = createHash('sha256').update(bytes).digest('hex'); const document = fixture(); const paragraph = document.blocks[0]; if(paragraph.type!=='paragraph')throw new Error('fixture');
    paragraph.runs.push({id:'inline-body',text:'',style:{},inlineImage:{assetId:1,sha256,alt:'Owned inline',width:12,height:12}});
    document.layout.header=[{type:'paragraph',id:'asset-header',style:{},runs:[{id:'inline-header',text:'',style:{},inlineImage:{assetId:1,sha256,alt:'Header inline',width:12,height:12}}]}];
    const prepared = await prepare(await exportStructuredDocx(document,'retain-review',new Map([[1,{bytes,mediaType:'image/png'}]]))); const receipt=await commitDocxImport(userId,bookId,prepared.preview.id,prepared.request); const scene=await documentService.read(userId,bookId,receipt.result.hierarchy.acts[0].chapters[0].sceneIds[0]); const bodyImages=imagesOf(scene.document);expect(bodyImages).toHaveLength(1);const scope=await documentService.scope(userId,bookId,'layout');const story=scope.content.headerFooterStories!.find((story)=>story.kind==='header')!;const images=[...bodyImages,...imagesOf(story.document)];expect(images).toHaveLength(2);
    for(const image of images){const asset=await db().imageAsset.findFirst({where:{id:image.assetId,userId,bookId}});expect(asset).toMatchObject({userId,bookId,source:'document-import'});expect(JSON.parse(asset!.configJson!)).toMatchObject({sha256,originalId:prepared.original.id,previewId:prepared.preview.id});}
    expect(scene.document.blocks[0].type==='paragraph'&&scene.document.blocks[0].runs.at(-1)?.inlineImage?.sha256).toBe(sha256);
  });
  test('owned header/footer table graphs preserve authenticated imported review and source-bound native publication', async () => {
    const { publicationDocx } = await import('@/documents/publicationDocx'); const { createPublicationJob,runPublicationJob,readPublicationArtifact } = await import('@/documents/publication'); const { createHash } = await import('node:crypto'); const { imagesOf } = await import('@/documents/model');
    const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=','base64');const sha256=createHash('sha256').update(bytes).digest('hex');
    const header=fixture();const paragraph=header.blocks[0];if(paragraph.type!=='paragraph')throw new Error('fixture');paragraph.style={alignment:'center'};paragraph.runs.push({id:randomUUID(),text:'',style:{},inlineImage:{assetId:1,sha256,alt:'Owned table story image',width:12,height:12}});header.blocks=[{type:'table',id:randomUUID(),widths:[200],rows:[{id:randomUUID(),cells:[{id:randomUUID(),paragraphs:[paragraph]}]}]}];
    const footer=structuredClone(header); const source=await publicationDocx({title:'Stories',author:'Author',revisionId:randomUUID(),sections:[{id:'scene',title:'Chapter',startsChapter:true,document:documentFromText('Body stays separate.',randomUUID),headerStory:{id:'header',document:header},footerStory:{id:'footer',document:footer}}],assets:new Map([[1,{bytes,mediaType:'image/png'}]])},'retain-review');
    // A safe but unsupported source feature: Word ignores these header/footer ranges.
    // Retain exact bytes and disclose the limitation before consent, rather than inventing native support.
    const sourceFiles=await validateDocxPackage(source,true);const storyParts=[...sourceFiles.keys()].filter((name)=>/\/(header|footer)\d+\.xml$/.test(name));
    for(const [index,name] of storyParts.entries()) {const xml=sourceFiles.get(name)!.toString();sourceFiles.set(name,Buffer.from(xml.replace(/(<w:ins[^>]*>)(<w:r>.*?<\/w:r>)/s,`$1<w:commentRangeStart w:id="${index}"/>$2<w:commentRangeEnd w:id="${index}"/><w:r><w:commentReference w:id="${index}"/></w:r>`)));}
    sourceFiles.set('word/comments.xml',Buffer.from(`<?xml version="1.0"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${storyParts.map((_,index)=>`<w:comment w:id="${index}" w:author="Comment author" w:date="2026-01-02T03:04:05.000Z"><w:p><w:r><w:t>Classic anchored comment.</w:t></w:r></w:p></w:comment>`).join('')}</w:comments>`));
    sourceFiles.set('word/_rels/document.xml.rels',Buffer.from(sourceFiles.get('word/_rels/document.xml.rels')!.toString().replace('</Relationships>','<Relationship Id="rIdStoryComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>')));
    sourceFiles.set('[Content_Types].xml',Buffer.from(sourceFiles.get('[Content_Types].xml')!.toString().replace('</Types>','<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>')));
    const prepared=await prepare(await createZipBuffer([...sourceFiles].map(([name,content])=>({name,content}))));expect((prepared.preview.report as {losses:Array<{code:string}>}).losses.some((loss)=>loss.code==='HEADER_FOOTER_COMMENTS')).toBe(true);expect(prepared.preview.headerFooterStories).toHaveLength(2);expect(prepared.preview.headerFooterStories!.every((story)=>story.document.blocks[0].type==='table')).toBe(true);
    const receipt=await commitDocxImport(userId,bookId,prepared.preview.id,prepared.request);const layout=(await documentService.scope(userId,bookId,'layout')).content;const stories=layout.headerFooterStories!;expect(stories).toHaveLength(2);
    for(const story of stories){expect(story.document.blocks[0].type).toBe('table');expect(story.document.changes[0]).toMatchObject({authorId:userId,authorName:'Authenticated importer',origin:'import',importedAuthor:'Word author',createdAt:'2026-01-02T03:04:05.000Z'});expect(story.document.comments[0]).toMatchObject({authorId:userId,importedAuthor:'Comment author',text:'Classic anchored comment.'});expect(imagesOf(story.document)).toHaveLength(1);}
    const scene=await documentService.read(userId,bookId,receipt.result.hierarchy.acts[0].chapters[0].sceneIds[0]);expect(scene.document.layout.header).toEqual([]);expect(scene.document.layout.footer).toEqual([]);expect(scene.document.comments).toEqual([]);
    const manifest=await documentService.manifest(userId,bookId);const job=await createPublicationJob(userId,bookId,{operationId:randomUUID(),expectedRevisionId:manifest.revisionId,options:{format:'docx',mode:'retain-review',preset:'saved'}});await runPublicationJob(userId,bookId,job.id);const {readPublicationJob}=await import('@/documents/publication');const saved=await readPublicationJob(userId,bookId,job.id);expect(saved.status).toBe('completed');const artifact=await readPublicationArtifact(userId,bookId,saved.artifactId!);const files=await validateDocxPackage(Buffer.from(artifact.bytes),true);const storyXml=[...files].filter(([name])=>/\/(header|footer)\d+\.xml$/.test(name)).map(([,content])=>content.toString());expect(storyXml.filter((xml)=>xml.includes('<w:tbl>'))).toHaveLength(2);expect(storyXml.filter((xml)=>xml.includes('commentRangeStart'))).toHaveLength(0);expect(saved.fidelity?.losses.join(' ')).toContain('Word ignores native comment anchors');expect(storyXml.filter((xml)=>xml.includes('Word author'))).toHaveLength(2);
    await db().documentPublicationArtifact.deleteMany({where:{bookId}});await db().documentPublication.deleteMany({where:{bookId}});
  });
  test('named style preview commits owned paragraph/character definitions and Unicode labels without replacing existing styles',async()=>{
    const {publicationDocx}=await import('@/documents/publicationDocx');const {publicationHtml}=await import('@/documents/publicationRender');const source=documentFromText('Named style body.',randomUUID);const p=source.blocks[0];if(p.type!=='paragraph')throw new Error('fixture');p.style={name:'body-style'};p.runs[0].style={characterStyleId:'emphasis',bold:false};const styles={paragraph:{'body-style':{name:'body-style',alignment:'center' as const}},text:{'body-style':{font:'Liberation Serif',size:20,bold:true},emphasis:{font:'Liberation Mono',italic:true}},labels:{'body-style':'Café body',emphasis:'Émphasis'}};
    const input={title:'Named styles',author:'Fixture',revisionId:randomUUID(),sections:[{id:'s',title:'Chapter',startsChapter:false,document:source}],styles,assets:new Map()};const bytes=await publicationDocx(input,'retain-review');const prepared=await prepare(bytes);const previewStyles=prepared.preview.styles!;expect(Object.values(previewStyles.labels!)).toEqual(expect.arrayContaining(['Café body','Émphasis']));expect(prepared.preview.documents[0].blocks[0].type==='paragraph'&&prepared.preview.documents[0].blocks[0].style.name).toMatch(/^import-/);
    const receipt=await commitDocxImport(userId,bookId,prepared.preview.id,prepared.request);const saved=(await documentService.scope(userId,bookId,'layout')).content;for(const [id,definition] of Object.entries(previewStyles.text))expect(saved.styles.text[id]).toEqual(definition);for(const [id,label] of Object.entries(previewStyles.labels!))expect(saved.styles.labels![id]).toBe(label);const imported=await documentService.read(userId,bookId,receipt.result.hierarchy.acts[0].chapters[0].sceneIds[0]);const html=publicationHtml({...input,sections:[{id:'i',title:'Chapter',document:imported.document}],styles:saved.styles},'final');expect(html).toContain('text-align:center');expect(html).toContain('font-family:&quot;Liberation Mono&quot;');expect(html).toContain('font-style:italic');expect(html).not.toContain('font-weight:bold');
  });
  test('stale source, forged report and cross-user original/preview reads cannot commit', async () => {
    const prepared = await prepare();
    await expect(
      readDocxImportPreview(otherUserId, bookId, prepared.preview.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      readImportOriginal(otherUserId, bookId, prepared.original.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      commitDocxImport(userId, bookId, prepared.preview.id, {
        ...prepared.request,
        consentReportHash: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ status: 409 });
    const current = await documentService.read(userId, bookId, sceneId);
    await documentService.commit(userId, bookId, {
      schemaVersion: 1,
      operationId: randomUUID(),
      expectedRevisionId: current.bookRevisionId,
      scenes: [
        {
          sceneId,
          expectedRevisionId: current.revisionId,
          document: documentFromText('Newer prose.', randomUUID),
        },
      ],
    });
    await expect(
      commitDocxImport(userId, bookId, prepared.preview.id, prepared.request),
    ).rejects.toMatchObject({ status: 412 });
  });
  test('malformed original remains recoverable after conversion fails', async () => {
    const bytes = Buffer.from('malformed DOCX bytes');
    const original = await preserveDocxOriginal(userId, bookId, randomUUID(), bytes);
    const head = await documentService.manifest(userId, bookId);
    await expect(
      prepareDocxImport(userId, bookId, {
        operationId: randomUUID(),
        originalId: original.id,
        expectedRevisionId: head.revisionId,
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(Buffer.from((await readImportOriginal(userId, bookId, original.id)).bytes)).toEqual(
      bytes,
    );
  });
});
