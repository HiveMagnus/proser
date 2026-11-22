import { effectiveParagraphStyle,effectiveTextStyle,type DocumentStyleDefinitions } from './style-model';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {installedFontFaces,auditRenderedFonts,type PublicationFontUsage} from './publicationFonts';
import { verifyPublicationFonts } from './runtimeReadiness';
import { chromium } from 'playwright';
import { createZipBuffer, type ZipEntry } from '@/lib/zipArchive';
import {
  type ProserDocument,
  type DocumentParagraph,
  type DocumentLayout,
  type DocumentView,
  projectDocument,
  canonicalDocument,
  visibleParagraph,
  visibleRun,
  runStyle,
  paragraphStyle,
  paragraphGroups,
  type DocumentBlock,
} from './model';
import { type DocxAsset, type ExportMode } from './docxExport';
import { DocumentError } from './errors';
export type PublicationFormat = 'docx' | 'epub' | 'pdf' | 'html' | 'markdown' | 'text' | 'json';
export interface PublicationSection {
  id: string;
  title: string;
  document: ProserDocument;
  sceneId?: number;
  sceneNumber?: number;
  chapterId?: number;
  chapterNumber?: number;
  actNumber?: number;
  startsChapter?: boolean;
  isCover?:boolean;
  headerStory?: {id:string;document:ProserDocument};
  footerStory?: {id:string;document:ProserDocument};
}
export const publicationDocuments = (section:PublicationSection):ProserDocument[] => [section.document,...[section.headerStory,section.footerStory].flatMap((story)=>story?[story.document]:[])];
export interface PublicationInput {
  title: string;
  author: string;
  revisionId: string;
  sections: PublicationSection[];
  assets: Map<number, DocxAsset>;
  styles?:DocumentStyleDefinitions;
  coverAssetId?:number;
  coverOmitted?:boolean;
}
export const escapeXml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
const cssValue = (text: string) => text.replace(/["'\\;{}<>\r\n]/g, '');
export const publicationView = (mode: ExportMode): DocumentView =>
  mode === 'retain-review' ? 'markup' : mode;
function paragraphHtml(
  block: DocumentParagraph,
  document: ProserDocument,
  view: DocumentView,
  assetUrl: (id: number) => string,
  definitions?:DocumentStyleDefinitions,
): string {
  if (!visibleParagraph(block, document.changes, view)) return '';
  const style = effectiveParagraphStyle(block,document,view,definitions);
  const tag = style.heading ? `h${style.heading}` : 'p';
  const visibleRuns=block.runs.filter((run)=>visibleRun(run,document.changes,view));
  const hasVisibleContent=visibleRuns.some((run)=>run.text.length>0||run.inlineImage);
  const emptyStyle=hasVisibleContent?undefined:effectiveTextStyle(visibleRuns.find((run)=>!run.inlineImage)??{id:'empty-line-box',text:'',style:{}},block,document,view,definitions);
  const rules = [
    `white-space:pre-wrap`,
    emptyStyle?.font?`font-family:"${cssValue(emptyStyle.font)}","DejaVu Sans"`:'',
    emptyStyle?.size?`font-size:${emptyStyle.size}px`:'',
    emptyStyle?.bold===undefined?'':emptyStyle.bold?'font-weight:bold':'font-weight:normal',
    emptyStyle?.italic===undefined?'':emptyStyle.italic?'font-style:italic':'font-style:normal',
    style.alignment ? `text-align:${style.alignment}` : '',
    style.lineSpacing ? `line-height:${style.lineSpacing}` : '',
    `margin-top:${style.before ?? 0}px`,
    `margin-bottom:${style.after ?? 8}px`,
    style.indent ? `margin-left:${style.indent}px` : '',
    style.firstLineIndent ? `text-indent:${style.firstLineIndent}px` : '',
    style.pageBreakBefore ? 'break-before:page' : '',
    style.keepWithNext ? 'break-after:avoid' : '',
  ]
    .filter(Boolean)
    .join(';');
  const content = block.runs
    .filter((run) => visibleRun(run, document.changes, view))
    .map((run) => {
      if (run.inlineImage) return `<img src="${escapeXml(assetUrl(run.inlineImage.assetId))}" alt="${escapeXml(run.inlineImage.alt)}" width="${run.inlineImage.width}" height="${run.inlineImage.height}" style="width:${run.inlineImage.width}px;height:${run.inlineImage.height}px" />`;
      const textStyle = effectiveTextStyle(run,block,document,view,definitions);
      const rules = [
        textStyle.font ? `font-family:"${cssValue(textStyle.font)}","DejaVu Sans"` : '',
        textStyle.size ? `font-size:${textStyle.size}px` : '',
        textStyle.bold === undefined ? '' : textStyle.bold ? 'font-weight:bold' : 'font-weight:normal',
        textStyle.italic === undefined ? '' : textStyle.italic ? 'font-style:italic' : 'font-style:normal',
        textStyle.underline || textStyle.strikeout
          ? `text-decoration:${[textStyle.underline ? 'underline' : '', textStyle.strikeout ? 'line-through' : ''].filter(Boolean).join(' ')}`
          : '',
        textStyle.color ? `color:${textStyle.color}` : '',
        textStyle.highlight ? `background-color:${textStyle.highlight}` : '',
      ]
        .filter(Boolean)
        .join(';');
      let result = `<span style="${escapeXml(rules)}">${escapeXml(run.text)}</span>`;
      if (textStyle.hyperlink)
        result = `<a href="${escapeXml(textStyle.hyperlink)}" rel="noopener noreferrer">${result}</a>`;
      const change = document.changes.find(
        (change) => change.id === run.changeId && change.status === 'pending',
      );
      if (view === 'markup' && change)
        result = `<${change.kind === 'deletion' ? 'del' : 'ins'} data-change-id="${escapeXml(change.id)}">${result}</${change.kind === 'deletion' ? 'del' : 'ins'}>`;
      return result;
    })
    .join('');
  const comments =
    view === 'markup'
      ? document.comments
          .filter(
            (comment) =>
              !comment.resolved && !comment.anchorStates?.length && comment.anchors.some((anchor) => block.runs.some((run) => run.id === anchor.runId)),
          )
          .map(
            (comment) =>
              `<aside class="review-comment" role="note">${escapeXml(comment.importedAuthor ?? comment.authorName)}: ${escapeXml(comment.text)}</aside>`,
          )
          .join('')
      : '';
  const value = `<${tag} data-block-id="${escapeXml(block.id)}" style="${escapeXml(rules)}">${content}${hasVisibleContent?'':'<br />'}</${tag}>${comments}`;
  return style.list
    ? `<${style.list === 'bullet' ? 'ul' : 'ol'}><li>${value}</li></${style.list === 'bullet' ? 'ul' : 'ol'}>`
    : value;
}
/** Render logical paragraphs without changing retained physical identities or review records. */
function publicationParagraphs(paragraphs: DocumentParagraph[], document: ProserDocument, view: DocumentView): DocumentParagraph[] {
  return paragraphGroups(paragraphs, document.changes, view).map((group) => ({ ...group[0]!, style: paragraphStyle(group[0]!, document.changes, view), runs: group.flatMap((block) => block.runs) }));
}
function publicationBlocks(document: ProserDocument, view: DocumentView): DocumentBlock[] {
  const result: DocumentBlock[] = []; let pending: DocumentParagraph[] = [];
  const flush = () => { result.push(...publicationParagraphs(pending, document, view)); pending = []; };
  for (const block of document.blocks) {
    if (block.type === 'paragraph') pending.push(block);
    else { flush(); result.push(block.type === 'table' ? { ...block, rows: block.rows.map((row) => ({ ...row, cells: row.cells.map((cell) => ({ ...cell, paragraphs: publicationParagraphs(cell.paragraphs, document, view) })) })) } : block); }
  }
  flush(); return result;
}
export function sectionHtml(
  section: PublicationSection,
  mode: ExportMode,
  assetUrl: (id: number) => string,
  definitions?:DocumentStyleDefinitions,
): string {
  const document = section.document;
  const view = publicationView(mode);
  const title = section.startsChapter && !section.isCover ? `<h1>${escapeXml(section.title)}</h1>` : '';
  return (
    title +
    publicationBlocks(document, view)
      .map((block) => {
        if (block.type === 'paragraph') return paragraphHtml(block, document, view, assetUrl,definitions);
        if (block.type === 'pageBreak') return '<div class="page-break" aria-hidden="true"></div>';
        if (block.type === 'image')
          return `<img src="${escapeXml(assetUrl(block.assetId))}" alt="${escapeXml(block.alt)}" width="${block.width}" height="${block.height}" style="width:${block.width}px;height:${block.height}px" />`;
        return `<table><tbody>${block.rows.map((row) => `<tr>${row.cells.map((cell, index) => `<td style="width:${block.widths[index]}px">${cell.paragraphs.map((paragraph) => paragraphHtml(paragraph, document, view, assetUrl,definitions)).join('')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
      })
      .join('').replace(/<\/ol><ol>/g, '').replace(/<\/ul><ul>/g, '') +
    (view === 'markup' ? document.comments.filter((comment) => !comment.resolved && comment.anchorStates?.length).map((comment) => `<aside class="review-comment" role="note" data-comment-status="detached">Detached comment (${escapeXml(comment.anchorStates!.map((state) => state.status + ': ' + state.reason).join(', '))}): ${escapeXml(comment.importedAuthor ?? comment.authorName)}: ${escapeXml(comment.text)}</aside>`).join('') : '')
  );
}
const extension = (asset: DocxAsset) =>
  asset.mediaType === 'image/jpeg' ? 'jpg' : asset.mediaType === 'image/png' ? 'png' : 'webp';
type PrintStories = Map<number, { header?: string; footer?: string }>;
export function printCss(layout: DocumentLayout, index: number, sectionTitle: string, stories?: {header?:string;footer?:string}): string {
  const [top, right, bottom, left] = layout.margins;
  const escaped = (text: string) => JSON.stringify(cssValue(text));
  const header = stories?.header ? `image-set(url("${stories.header}") ${300/96}x)` : layout.preset === 'book' && !layout.header.length ? escaped(sectionTitle) : '""';
  const footer = stories?.footer ? `image-set(url("${stories.footer}") ${300/96}x)` : '""';
  return `@page section${index} { size:${layout.width}px ${layout.height}px; margin:${top}px ${right}px ${bottom}px ${left}px; @top-center { content:${header}; font-family:${escaped(layout.font)},"DejaVu Sans"; font-size:${layout.fontSize}px } @bottom-center { font-family:${escaped(layout.font)},"DejaVu Sans"; white-space:pre; content:${layout.pageNumbers ? footer + ' "\\a" counter(page)' : footer}; font-size:${layout.fontSize}px } } @page section${index}:left { margin-left:${right}px; margin-right:${left}px } .section-${index} { page:section${index}; font-family:${escaped(layout.font)},"DejaVu Sans"; font-size:${layout.fontSize}px }`;
}
export function publicationHtml(input: PublicationInput, mode: ExportMode, stories?: PrintStories): string {
  const assets = (id: number) => {
    const asset = input.assets.get(id);
    if (!asset)
      throw new DocumentError('EXPORT_ASSET_UNAVAILABLE', 'Verified asset is unavailable.', 409);
    return `data:${asset.mediaType};base64,${asset.bytes.toString('base64')}`;
  };
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${escapeXml(input.title)}</title><style>body{margin:0;color:#111}table{border-collapse:collapse;max-width:100%;table-layout:fixed}td{border:1px solid #777;padding:6px;overflow-wrap:anywhere}img{max-width:100%;height:auto}ins{color:#17643b}del{color:#a12222}.page-break{break-after:page}.section-0{break-before:auto}${input.sections.map((section, index) => (index > 0 && section.startsChapter === false ? '' : printCss(section.document.layout, index, section.title, stories?.get(index)))).join('')}.chapter-start{break-before:page}.chapter-start:first-child{break-before:auto}</style></head><body>${input.sections
    .map((section, index) => {
      const group =
        section.startsChapter === false
          ? input.sections
              .slice(0, index + 1)
              .reduce((last, item, index) => (item.startsChapter !== false ? index : last), 0)
          : index;
      const story = (kind:'header'|'footer') => {const owned=kind==='header'?section.headerStory:section.footerStory;return owned?`<div style="font-family:${escapeXml(JSON.stringify(cssValue(owned.document.layout.font)))};font-size:${owned.document.layout.fontSize}px">${sectionHtml({...section,id:owned.id,document:owned.document,startsChapter:false},mode,assets,input.styles)}</div>`:publicationParagraphs(section.document.layout[kind],section.document,publicationView(mode)).map((paragraph)=>paragraphHtml(paragraph,section.document,publicationView(mode),assets,input.styles)).join('');};
      const semanticStories = !stories && (index === 0 || section.startsChapter !== false);
      return `<section class="section-${group}${section.startsChapter !== false ? ' chapter-start' : ''}" aria-label="${escapeXml(section.title)}">${semanticStories ? '<header class="story">' + story('header') + '</header>' : ''}${sectionHtml(section, mode, assets,input.styles)}${semanticStories ? '<footer class="story">' + story('footer') + '</footer>' : ''}</section>`;
    })
    .join('')}</body></html>`;
}
export async function publicationPdf(
  input: PublicationInput,
  mode: ExportMode,
): Promise<{
  bytes: Buffer;
  version: string;
  fonts: Awaited<ReturnType<typeof verifyPublicationFonts>>;
  substitutions: Array<{ requested: string; actual: string }>;
  fontUsage:PublicationFontUsage[];
}> {
  const fonts = await verifyPublicationFonts();
  const fontFaces=await installedFontFaces(fonts);const fontUsage:PublicationFontUsage[]=[];
  const rendered = { ...input, sections: structuredClone(input.sections),styles:input.styles?structuredClone(input.styles):undefined };
  const names = new Set(fonts.map((font) => font.name));
  const fallback = names.has('Liberation Serif') ? 'Liberation Serif' : fonts[0].name;
  const substitutions = new Map<string, string>();
  const fontName = (name: string) => {
    if (names.has(name)) return name;
    substitutions.set(name, fallback);
    return fallback;
  };
  for(const style of Object.values(rendered.styles?.text??{}))if(style.font)style.font=fontName(style.font);
  for (const section of rendered.sections) {
    section.document.layout.font = fontName(section.document.layout.font);
    for (const document of publicationDocuments(section)) {
    document.layout.font = fontName(document.layout.font);
    for (const change of document.changes) { if (change.beforeStyle?.font) change.beforeStyle.font = fontName(change.beforeStyle.font); if (change.afterStyle?.font) change.afterStyle.font = fontName(change.afterStyle.font); }
    for (const block of [
      ...document.blocks.filter((block) => block.type === 'paragraph'),
      ...document.layout.header,
      ...document.layout.footer,
      ...document.blocks
        .filter((block) => block.type === 'table')
        .flatMap((block) =>
          block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.paragraphs)),
        ),
    ])
      for (const run of block.runs) if (run.style.font) run.style.font = fontName(run.style.font);
    }
  }
  const faces = (
    await Promise.all(
      fonts.map(
        async (font) =>
          `@font-face {font-family:"${cssValue(font.name)}";src:url(data:font/ttf;base64,${(await readFile(font.path)).toString('base64')}) format('truetype');font-weight:${/bold/i.test(font.path) ? 'bold' : 'normal'};font-style:${/italic|oblique/i.test(font.path) ? 'italic' : 'normal'};}`,
      ),
    )
  ).join('');
  const browser = await chromium.launch({ headless: true });
  try {
    const stories: PrintStories = new Map();
    for (const [index, section] of rendered.sections.entries()) if (index === 0 || section.startsChapter !== false) {
      const layout = section.document.layout; const result: {header?:string;footer?:string} = {};
      for (const name of ['header','footer'] as const) if (layout[name].length || (name==='header'?section.headerStory:section.footerStory)) {
        const width = Math.floor(layout.width - layout.margins[1] - layout.margins[3]);
        const maximumHeight = Math.floor((name === 'header' ? layout.margins[0] : layout.margins[2] - (layout.pageNumbers ? layout.fontSize : 0)) - 16);
        if (width < 1 || maximumHeight < 1) throw new DocumentError('PUBLICATION_STORY_OVERFLOW', 'Margins leave no room for the saved header/footer story.', 422);
        const storyPage = await browser.newPage({viewport:{width,height:Math.max(1,maximumHeight)},deviceScaleFactor:300/96});
        try {
          await storyPage.route('**/*', (route) => route.abort());
          const assetUrl = (id:number) => { const asset=input.assets.get(id); if(!asset)throw new DocumentError('EXPORT_ASSET_UNAVAILABLE','Story asset is unavailable.',409);return `data:${asset.mediaType};base64,${asset.bytes.toString('base64')}`; };
          const owned=name==='header'?section.headerStory:section.footerStory;
          const storyTypography = owned?.document.layout ?? layout;
          const content = owned?sectionHtml({...section,id:owned.id,document:owned.document,startsChapter:false},mode,assetUrl,rendered.styles):publicationParagraphs(layout[name],section.document,publicationView(mode)).map((paragraph)=>paragraphHtml(paragraph,section.document,publicationView(mode),assetUrl,rendered.styles)).join('');
          await storyPage.setContent(`<!doctype html><style>${faces}body{margin:0;color:#111;font-family:"${cssValue(storyTypography.font)}","DejaVu Sans";font-size:${storyTypography.fontSize}px}p,h1,h2,h3,h4,h5,h6{margin:0}img{vertical-align:middle}table{border-collapse:collapse;table-layout:fixed;max-width:100%}td{border:1px solid #777;padding:6px;overflow-wrap:anywhere}ins{color:#17643b}del{color:#a12222}</style><div id="story">${content}</div>`);
          await storyPage.evaluate('Promise.all([document.fonts.ready,...Array.from(document.images,image=>image.decode())])');
          fontUsage.push(await auditRenderedFonts(storyPage,fontFaces,`${name}:${section.id}`));
          // Browser code is a fixed script: Node coverage instrumentation must never
          // be serialized into the isolated renderer realm.
          const dimensions = await storyPage.evaluate<{height:number;width:number}>("(()=>{const element=document.getElementById('story');return {height:Math.ceil(element.getBoundingClientRect().height),width:Math.ceil(element.scrollWidth)};})()");
          if(dimensions.height>maximumHeight||dimensions.width>width)throw new DocumentError('PUBLICATION_STORY_OVERFLOW', `${name} story exceeds saved page margins. Adjust its layout before publication.`,422);
          if (!dimensions.height) continue;
          const bytes = await storyPage.locator('#story').screenshot({type:'png',omitBackground:true});
          result[name] = `data:image/png;base64,${bytes.toString('base64')}`;
        } finally { await storyPage.close(); }
      }
      stories.set(index,result);
    }
    const page = await browser.newPage();
    // Canonical HTML is self-contained; disable every network request, including fonts.
    await page.route('**/*', (route) => route.abort());
    await page.setContent(publicationHtml(rendered, mode, stories).replace('<style>', '<style>' + faces), {
      waitUntil: 'load',
      timeout: 30_000,
    });
    try { await page.evaluate('Promise.all([document.fonts.ready,...Array.from(document.images,image=>image.decode())])'); }
    catch { throw new DocumentError('EXPORT_ASSET_UNAVAILABLE','A publication image could not be decoded completely by the pinned renderer.',409); }
    fontUsage.push(await auditRenderedFonts(page,fontFaces,'body'));
    const bytes = await page.pdf({ printBackground: true, preferCSSPageSize: true });
    if (!bytes.subarray(0, 5).equals(Buffer.from('%PDF-')))
      throw new DocumentError(
        'PUBLICATION_PDF_INVALID',
        'Renderer did not produce a genuine PDF.',
        500,
      );
    return {
      bytes,
      version: browser.version(),
      fonts,
      fontUsage,
      substitutions: Array.from(substitutions, ([requested, actual]) => ({ requested, actual })),
    };
  } finally {
    await browser.close();
  }
}
export async function publicationEpub(input: PublicationInput, mode: ExportMode): Promise<Buffer> {
  if (!input.sections.length) throw new DocumentError('PUBLICATION_CONTENT_EMPTY', 'EPUB requires at least one owned content section.', 422);
  const entries: ZipEntry[] = [
    { name: 'mimetype', content: 'application/epub+zip', store: true },
    {
      name: 'META-INF/container.xml',
      content:
        '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    },
  ];
  const assetUrl = (id: number) => {
    const asset = input.assets.get(id);
    if (!asset)
      throw new DocumentError('EXPORT_ASSET_UNAVAILABLE', 'Verified asset is unavailable.', 409);
    return `assets/${id}.${extension(asset)}`;
  };
  for (const [id, asset] of input.assets)
    entries.push({ name: `OEBPS/assets/${id}.${extension(asset)}`, content: asset.bytes });
  const files = input.sections.map((section, index) => ({
    id: `s${index}`,
    name: `section-${index}.xhtml`,
    section,
  }));
  const chapterNavigation = files.filter((file) => file.section.startsChapter !== false && !file.section.isCover);
  const navigation = chapterNavigation.length ? chapterNavigation : [files.find((file) => !file.section.isCover) ?? files[0]];
  for (const item of files)
    entries.push({
      name: `OEBPS/${item.name}`,
      content: `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" lang="en" xml:lang="en"><head><title>${escapeXml(item.section.title)}</title><meta charset="utf-8"/><style>table{border-collapse:collapse}td{border:1px solid;padding:0.3em}img{max-width:100%;height:auto}</style></head><body>${sectionHtml(item.section, mode, assetUrl,input.styles)}</body></html>`,
    });
  entries.push({
    name: 'OEBPS/nav.xhtml',
    content: `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en"><head><title>Contents</title></head><body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${navigation
      .map((file) => `<li><a href="${file.name}">${escapeXml(file.section.title)}</a></li>`)
      .join('')}</ol></nav>${files.some((file)=>file.section.isCover)?'<nav epub:type="landmarks"><ol>'+files.filter((file)=>file.section.isCover).map((file)=>'<li><a epub:type="cover" href="'+file.name+'">Cover</a></li>').join('')+'</ol></nav>':''}</body></html>`,
  });
  const modified = '2000-01-01T00:00:00Z';
  entries.push({
    name: 'OEBPS/content.opf',
    content: `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:uuid:${escapeXml(input.revisionId)}</dc:identifier><dc:title>${escapeXml(input.title)}</dc:title><dc:creator>${escapeXml(input.author)}</dc:creator><dc:language>en</dc:language><meta property="dcterms:modified">${modified}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${files.map((file) => `<item id="${file.id}" href="${file.name}" media-type="application/xhtml+xml"/>`).join('')}${Array.from(
      input.assets,
    )
      .map(
        ([id, asset]) =>
          `<item id="asset${id}" href="${assetUrl(id)}" media-type="${asset.mediaType}"${id===input.coverAssetId ? ' properties="cover-image"' : ''}/>`,
      )
      .join(
        '',
      )}${mode === 'retain-review' ? '<item id="review" href="review.json" media-type="application/json"/>' : ''}</manifest><spine>${files.map((file) => `<itemref idref="${file.id}"/>`).join('')}</spine></package>`,
  });
  if (mode === 'retain-review')
    entries.push({ name: 'OEBPS/review.json', content: JSON.stringify(reviewSidecar(input)) });
  return createZipBuffer(entries);
}
/** JSON compatibility exports project review without accepting it in the saved authority. */
export function publicationJson(input:PublicationInput,mode:ExportMode,sourceManifest:unknown):string {
  const view=publicationView(mode);
  const projected=(document:ProserDocument):ProserDocument=>{
    if(view==='markup')return structuredClone(document);
    const paragraph=(block:DocumentParagraph):DocumentParagraph=>{const result={...block,style:paragraphStyle(block,document.changes,view),runs:block.runs.filter((run)=>visibleRun(run,document.changes,view)).map((run)=>{const copy={...run,style:runStyle(run,document.changes,view)};delete copy.changeId;return copy;})};delete result.changeId;delete result.boundaryChangeId;return result;};
    return {...document,blocks:publicationBlocks(document,view).filter((block)=>block.type!=='paragraph'||visibleParagraph(block,document.changes,view)).map((block)=>block.type==='paragraph'?paragraph(block):block.type==='table'?{...block,rows:block.rows.map((row)=>({...row,cells:row.cells.map((cell)=>({...cell,paragraphs:cell.paragraphs.filter((block)=>visibleParagraph(block,document.changes,view)).map(paragraph)}))}))}:structuredClone(block)),layout:{...document.layout,header:publicationParagraphs(document.layout.header,document,view).filter((block)=>visibleParagraph(block,document.changes,view)).map(paragraph),footer:publicationParagraphs(document.layout.footer,document,view).filter((block)=>visibleParagraph(block,document.changes,view)).map(paragraph)},changes:[],comments:[]};
  };
  return canonicalDocument({schemaVersion:1,sourceManifest,revisionId:input.revisionId,mode,projection:view,styles:input.styles,sections:input.sections.map((section)=>({...section,document:projected(section.document),headerStory:section.headerStory?{...section.headerStory,document:projected(section.headerStory.document)}:undefined,footerStory:section.footerStory?{...section.footerStory,document:projected(section.footerStory.document)}:undefined}))});
}
export const reviewSidecar = (input: PublicationInput) => ({
  schemaVersion: 1,
  sourceRevisionId: input.revisionId,
  sections: input.sections.map(({ id, document, headerStory, footerStory }) => ({
    id,
    changes: document.changes,
    comments: document.comments,
    headerStory, footerStory,
  })),
});
export function publicationMarkdown(input: PublicationInput, mode: ExportMode): string {
  const view = publicationView(mode);
  return input.sections
    .map(
      (section) =>
        `${section.startsChapter === false ? '' : '# ' + section.title.replace(/[\r\n]/g, ' ') + '\n\n'}${publicationBlocks(section.document, view)
          .map((block) => {
            if (block.type === 'pageBreak') return '\n---\n';
            if (block.type === 'image')
              return `![${block.alt.replace(/[\[\]\r\n]/g, '')}](asset:${block.assetId}@${block.sha256})`;
            if (block.type === 'table')
              return block.rows
                .map((row) =>
                  row.cells
                    .map((cell) =>
                      cell.paragraphs
                        .map((paragraph) =>
                          paragraph.runs
                            .filter((run) => visibleRun(run, section.document.changes, view))
                            .map((run) => run.inlineImage ? `![${run.inlineImage.alt.replace(/[\[\]\r\n]/g, '')}](asset:${run.inlineImage.assetId}@${run.inlineImage.sha256})` : run.text)
                            .join(''),
                        )
                        .join(' '),
                    )
                    .join('\t'),
                )
                .join('\n');
            if (!visibleParagraph(block, section.document.changes, view)) return '';
            const content = block.runs
              .filter((run) => visibleRun(run, section.document.changes, view))
              .map((run) => {
                if (run.inlineImage) return `![${run.inlineImage.alt.replace(/[\[\]\r\n]/g, '')}](asset:${run.inlineImage.assetId}@${run.inlineImage.sha256})`;
                const style = effectiveTextStyle(run,block,section.document,view,input.styles);
                let text = run.text.replace(/([\\`*_{}\[\]<>])/g, '\\$1');
                if (style.bold) text = `**${text}**`;
                if (style.italic) text = `*${text}*`;
                if (style.strikeout) text = `~~${text}~~`;
                if (style.hyperlink)
                  text = `[${text}](${style.hyperlink.replace(/[()]/g, (match) => encodeURIComponent(match))})`;
                return text;
              })
              .join('');
            const paragraph = paragraphStyle(block, section.document.changes, view);
            return `${paragraph.heading ? '#'.repeat(paragraph.heading) + ' ' : paragraph.list === 'bullet' ? '- ' : paragraph.list === 'number' ? '1. ' : ''}${content}`;
          })
          .join('\n\n')}`,
    )
    .join('\n\n');
}
export const publicationText = (input: PublicationInput, mode: ExportMode) =>
  input.sections
    .map((section) => projectDocument(section.document, publicationView(mode)).text)
    .join('\n\n');
export const bytesSha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
