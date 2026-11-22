import {readFile} from 'node:fs/promises';
import {verifyPublicationFonts} from '@/documents/runtimeReadiness';
import {auditRenderedFonts,inspectFontMetadata} from '@/documents/publicationFonts';
import {chromium} from 'playwright';
describe('bounded pinned font name/cmap authority',()=>{
 test('truncated or out-of-bounds sfnt metadata fails visibly',()=>{for(const bytes of [Buffer.alloc(0),Buffer.from('0001000000010000000000006e616d6500000000ffffffffffffffff','hex')])expect(()=>inspectFontMetadata(bytes)).toThrow(expect.objectContaining({code:'PUBLICATION_FONT_INVALID'}));});
 test('font verification rejects oversized typography before probes and clears transient attributes',async()=>{const browser=await chromium.launch({headless:true});try{const page=await browser.newPage();await page.setContent(Array.from({length:4097},(_,index)=>`<span style="font-size:${index+1}px">x</span>`).join(''));await expect(auditRenderedFonts(page,new Map(),'limit')).rejects.toMatchObject({status:413,code:'PUBLICATION_FONT_AUDIT_LIMIT'});expect(await page.locator('[data-proser-font-probe],[data-proser-font-original]').count()).toBe(0);}finally{await browser.close();}},15_000);
 test('real pinned DejaVu face identifies supplementary emoji, combining marks and missing CJK glyphs',async()=>{const bytes=await readFile((await verifyPublicationFonts()).find((font)=>font.path.endsWith('/DejaVuSans.ttf'))!.path);const metadata=inspectFontMetadata(bytes);expect(metadata.postScriptNames).toContain('DejaVuSans');expect(metadata.hasGlyph(0x1f600)).toBe(true);expect(metadata.hasGlyph(0x301)).toBe(true);expect(metadata.hasGlyph(0x6f22)).toBe(false);});
});
