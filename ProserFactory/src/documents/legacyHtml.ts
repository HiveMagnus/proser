import { createHash } from 'node:crypto';
import type { Element, Node } from '@xmldom/xmldom';
import { parseDocumentXml } from './packageValidation';
import { DocumentError } from './errors';
import { defaultLayout, canonicalDocument, type ProserDocument, type DocumentParagraph, type DocumentRun, type TextStyle, type ParagraphStyle, type DocumentBlock } from './model';
import { compatibilityOperationId } from './operationIdentity';
import { validateDocument } from './validation';
export interface LegacyHtmlFidelity { schemaVersion: 1; codec: 'proser-supported-html-v1'; sourceSha256: string; convertedHash: string; losses: string[]; externalResources: string[] }
/** Strict fragment conversion; no network, scripts, guessed table geometry or
 * silently repaired HTML. XML preflight bounds complexity before DOM allocation. */
export function convertSupportedLegacyHtml(raw: string, scopeIdentity: string): { document: ProserDocument; fidelity: LegacyHtmlFidelity } {
  const bytes = Buffer.from(raw, 'utf8');
  if (bytes.length > 2 * 1024 * 1024) throw new DocumentError('DOCUMENT_TOO_LARGE', 'Legacy HTML scene exceeds 2 MiB.', 413);
  if (/<!\s*(?:DOCTYPE|ENTITY)|<\?xml/i.test(raw)) throw new DocumentError('DOCUMENT_LEGACY_HTML_UNSAFE', 'DTD, entities and processing declarations are unsupported.', 422);
  const losses = new Set<string>(); const external = new Set<string>();
  if (/\r/.test(raw)) losses.add('HTML XML parsing normalizes CR/CRLF to LF; original bytes are preserved.');
  // Scan tags with quoted attributes intact, self-closing only known HTML voids.
  let normalized = ''; let index = 0;
  while (index < raw.length) {
    if (raw[index] !== '<') { normalized += raw[index++]; continue; }
    const start = index++; let quote = '';
    while (index < raw.length) {
      const char = raw[index++];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (quote || raw[index - 1] !== '>') throw new DocumentError('DOCUMENT_LEGACY_HTML_INVALID', 'Unterminated HTML tag.', 422);
    let tag = raw.slice(start, index);
    if (/^<(?:br|hr|img|input|meta|link)\b/i.test(tag) && !/\/\s*>$/.test(tag)) tag = tag.slice(0,-1) + '/>';
    normalized += tag;
  }
  normalized = normalized.replace(/&nbsp;/g, '&#160;');
  const dom = parseDocumentXml(Buffer.from(`<proser-fragment>${normalized}</proser-fragment>`, 'utf8'));
  const sourceSha256 = createHash('sha256').update(bytes).digest('hex'); let sequence = 0;
  const id = () => compatibilityOperationId('proser.legacy-html.identity.v1', { scopeIdentity, sourceSha256, sequence: sequence++ });
  const children = (node: Node): Node[] => Array.from({ length: node.childNodes.length }, (_, child) => node.childNodes.item(child)!);
  const css = (element: Element): Map<string,string> => {
    for (let attribute = 0; attribute < element.attributes.length; attribute++) { const attr = element.attributes.item(attribute)!; if (/^on/i.test(attr.name)) losses.add('Active event attributes removed.'); }
    if (element.getAttribute('class')) losses.add('Stylesheet class formatting is unavailable; class references were removed.');
    const styles = new Map<string,string>(); const priority = new Set<string>();
    for (const declaration of (element.getAttribute('style') ?? '').split(';')) {
      const colon = declaration.indexOf(':'); if (colon < 0) { if (declaration.trim()) losses.add('Unrecognized CSS declaration removed.'); continue; }
      const key = declaration.slice(0,colon).trim().toLowerCase(); const rawValue = declaration.slice(colon+1).trim(); const important = /\s*!important\s*$/i.test(rawValue); const value = rawValue.replace(/\s*!important\s*$/i,'').trim();
      if (important) losses.add('CSS important priority is not retained outside the converted inline value.');
      if (!priority.has(key) || important) { styles.set(key,value); if (important) priority.add(key); }
    }
    return styles;
  };
  const length = (value: string) => { const matched = /^(\d+(?:\.\d+)?)(px|pt)?$/.exec(value); return matched ? Number(matched[1]) * (matched[2] === 'pt' ? 4/3 : 1) : undefined; };
  const textStyle = (element: Element, inherited: TextStyle): TextStyle => {
    const style = { ...inherited }; const name = element.tagName.toLowerCase();
    if (['b','strong'].includes(name)) style.bold = true; if (['i','em'].includes(name)) style.italic = true; if (name === 'u') style.underline = true; if (['s','del','strike'].includes(name)) style.strikeout = true; if(name==='del')losses.add('HTML del renders as strikeout; native review attribution was not recorded.');
    if (name === 'a') { const href = element.getAttribute('href') ?? ''; if (/^https?:\/\//i.test(href)) { try { style.hyperlink = new URL(href).toString(); } catch { losses.add('Invalid hyperlink removed.'); } } else if (href) losses.add('Unsupported or active hyperlink removed.'); }
    for (const [key,value] of css(element)) {
      if (key === 'font-family') { if (value.length > 0 && value.length <= 100 && !/[{}(),]/.test(value)) style.font = value.replace(/^['"]|['"]$/g,''); else losses.add('Unsupported font family or fallback list removed.'); }
      else if (key === 'font-size') { const size = length(value); if (size !== undefined && size >= 6 && size <= 144) style.size = size; else losses.add('Unsupported font size removed.'); }
      else if (key === 'font-weight') { if (['bold','700'].includes(value)) style.bold = true; else if (['normal','400'].includes(value)) style.bold = false; else if (/^[1-9]00$/.test(value)) { style.bold = Number(value) >= 600; losses.add('Numeric font weight reduced to supported bold/normal formatting.'); } else losses.add('Unsupported relative font weight removed.'); }
      else if (key === 'font-style') { if (value === 'italic' || value === 'normal') style.italic = value === 'italic'; else losses.add('Unsupported font style removed.'); }
      else if (key === 'text-decoration' || key === 'text-decoration-line') { const tokens=value.split(/\s+/); style.underline = tokens.includes('underline'); style.strikeout = tokens.includes('line-through'); if(tokens.some((token)=>!['underline','line-through','none'].includes(token)))losses.add('Unsupported text decoration reduced to underline/strikeout.'); }
      else if (key === 'color' || key === 'background-color') { if (/^#[0-9a-f]{6}$/i.test(value)) { if (key === 'color') style.color = value; else style.highlight = value; } else losses.add('Unsupported CSS color removed.'); }
      else if (!['text-align','margin-top','margin-bottom','margin-left','text-indent','line-height','page-break-before','break-before','page-break-after','break-after'].includes(key)) losses.add(`Unsupported CSS ${key} removed.`);
    }
    return style;
  };
  const paragraphStyle = (element: Element): ParagraphStyle => {
    const style: ParagraphStyle = {}; const tag = element.tagName.toLowerCase(); if (/^h[1-6]$/.test(tag)) style.heading = Number(tag[1]) as ParagraphStyle['heading'];
    for (const [key,value] of css(element)) {
      if (key === 'text-align') { if (['left','center','right','justify'].includes(value)) style.alignment = value as ParagraphStyle['alignment']; else losses.add('Unsupported paragraph alignment removed.'); }
      else if (['margin-top','margin-bottom','margin-left','text-indent'].includes(key)) { const amount = length(value); if (amount === undefined || amount > 500) losses.add(`Unsupported paragraph ${key} removed.`); else if (key === 'margin-top') style.before = amount; else if (key === 'margin-bottom') style.after = amount; else if (key === 'margin-left') style.indent = amount; else style.firstLineIndent = amount; }
      else if (key === 'line-height') { const amount=Number(value); if (amount>=0.5&&amount<=5) style.lineSpacing=amount; else losses.add('Unsupported line height removed.'); }
      else if (['page-break-before','break-before'].includes(key)) { if (['always','page'].includes(value)) style.pageBreakBefore = true; else if (value !== 'auto') losses.add('Unsupported paragraph break before removed.'); }
      else if (['page-break-after','break-after'].includes(key)) losses.add('CSS page break after requires explicit structural break and was removed.');
    }
    return style;
  };
  const inline = (node: Node, inherited: TextStyle): DocumentRun[] => {
    if (node.nodeType === 3 || node.nodeType === 4) return [{ id: id(), text: node.nodeValue ?? '', style: { ...inherited } }];
    if (node.nodeType !== 1) return [];
    const element = node as Element; const tag = element.tagName.toLowerCase();
    if (['script','style','iframe','object','embed','input','meta','link'].includes(tag)) { losses.add(`Active/unsupported ${tag} content removed.`); return []; }
    if (tag === 'br') return [{ id: id(), text: '\n', style: { ...inherited } }];
    if (tag === 'img') { const src=element.getAttribute('src'); if (src) external.add(src); losses.add('Unregistered HTML image reference removed; original reference preserved in report.'); return element.getAttribute('alt') ? [{ id:id(),text:element.getAttribute('alt')!,style:{...inherited} }] : []; }
    if (!['span','b','strong','i','em','u','s','strike','del','a','p','li','h1','h2','h3','h4','h5','h6','td','th','div','section','article','body','html'].includes(tag)) throw new DocumentError('DOCUMENT_LEGACY_HTML_UNSUPPORTED', `Unsupported inline ${tag}; explicit conversion is required.`, 422);
    const next = textStyle(element,inherited); return children(element).flatMap((child)=>inline(child,next));
  };
  const paragraph = (element: Element, list?: ParagraphStyle['list']): DocumentParagraph => {
    const runs = inline(element,{}); return { type:'paragraph',id:id(),style:{...paragraphStyle(element),...(list?{list}:{})},runs:runs.length?runs:[{id:id(),text:'',style:{}}] };
  };
  const blocks: DocumentBlock[] = [];
  const walk = (node: Node) => {
    if (node.nodeType===3 || node.nodeType===4) { if ((node.nodeValue??'').trim()) blocks.push({type:'paragraph',id:id(),style:{},runs:inline(node,{})}); else if(node.nodeValue) losses.add('Whitespace between HTML blocks is structural and is not retained as prose.'); return; }
    if(node.nodeType!==1)return;
    const element=node as Element; const tag=element.tagName.toLowerCase();
    if(['p','h1','h2','h3','h4','h5','h6'].includes(tag))blocks.push(paragraph(element));
    else if(['div','section','article','body','html'].includes(tag)) { const content=children(element); const hasBlocks=content.some((child)=>child.nodeType===1&&['p','div','section','article','h1','h2','h3','h4','h5','h6','ul','ol','table','hr'].includes((child as Element).tagName.toLowerCase())); if(!hasBlocks)blocks.push(paragraph(element)); else { if(element.getAttribute('style'))losses.add('Container layout CSS removed; paragraph formatting is retained.'); content.forEach(walk); } }
    else if(tag==='ul'||tag==='ol') { for(const child of children(element)) { if(child.nodeType===3&&(child.nodeValue??'').trim()==='')continue; if(child.nodeType!==1||(child as Element).tagName.toLowerCase()!=='li')throw new DocumentError('DOCUMENT_LEGACY_HTML_UNSUPPORTED','Nested or ambiguous list structure requires review.',422); blocks.push(paragraph(child as Element,tag==='ul'?'bullet':'number')); } }
    else if(tag==='table') {
      if(element.getAttribute('style')||element.getAttribute('width')||element.getAttribute('border'))losses.add('HTML table geometry/border CSS is not represented; rectangular semantic cells are retained.');
      const rows: Array<Element>=[]; const collect=(item:Node)=>{if(item.nodeType===3&&(item.nodeValue??'').trim()==='')return; if(item.nodeType!==1)return; const entry=item as Element; const name=entry.tagName.toLowerCase(); if(name==='tr')rows.push(entry); else if(['thead','tbody','tfoot'].includes(name))children(entry).forEach(collect); else throw new DocumentError('DOCUMENT_LEGACY_HTML_UNSUPPORTED','Unsupported table structure requires review.',422);}; children(element).forEach(collect);
      const converted=rows.map((row)=>({id:id(),cells:children(row).filter((child)=>child.nodeType===1).map((child)=>{const cell=child as Element; if(!['td','th'].includes(cell.tagName.toLowerCase())||Number(cell.getAttribute('colspan')??1)!==1||Number(cell.getAttribute('rowspan')??1)!==1)throw new DocumentError('DOCUMENT_LEGACY_HTML_UNSUPPORTED','Merged or ambiguous table cells require review.',422); const nested=children(cell).filter((item)=>item.nodeType===1&&(item as Element).tagName.toLowerCase()==='p'); if(nested.length&&cell.getAttribute('style'))losses.add('Table-cell container CSS above nested paragraphs is not represented.'); if(nested.length&&children(cell).some((item)=>item.nodeType===3?(item.nodeValue??'').trim()!=='':item.nodeType===1&&(item as Element).tagName.toLowerCase()!=='p'))throw new DocumentError('DOCUMENT_LEGACY_HTML_UNSUPPORTED','Mixed table-cell block/inline content requires review.',422); const paragraphs=nested.length?nested.map((item)=>paragraph(item as Element)):[paragraph(cell)]; return {id:id(),paragraphs};})}));
      const columns=converted[0]?.cells.length??0; if(!columns||converted.some((row)=>row.cells.length!==columns))throw new DocumentError('DOCUMENT_LEGACY_HTML_UNSUPPORTED','Nonrectangular table requires review.',422); blocks.push({type:'table',id:id(),widths:Array(columns).fill(600/columns),rows:converted});
    } else if(tag==='hr') blocks.push({type:'pageBreak',id:id()});
    else if(['script','style','iframe','object','embed','input','meta','link','img'].includes(tag)){ const runs=inline(element,{}); if(runs.length)blocks.push({type:'paragraph',id:id(),style:{},runs}); }
    else {const runs=inline(element,{}); if(runs.length)blocks.push({type:'paragraph',id:id(),style:{},runs});}
  };
  children(dom.documentElement!).forEach(walk);
  const document=validateDocument({schemaVersion:1,blocks,changes:[],comments:[],layout:defaultLayout()});
  return {document,fidelity:{schemaVersion:1,codec:'proser-supported-html-v1',sourceSha256,convertedHash:createHash('sha256').update(canonicalDocument(document)).digest('hex'),losses:[...losses].sort(),externalResources:[...external].sort()}};
}
