import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { documentSchema, validateDocument } from '@/documents/validation';
import type { ProserDocument } from '@/documents/model';
const root = path.resolve(process.cwd(), 'evaluation');
const manifestPath = path.join(root, 'manifests/document-editing-v1.json');
export const documentCorpusHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const target = z.object({ blockId: z.string(), from: z.number().int().nonnegative(), to: z.number().int().nonnegative(), sourceText: z.string() }).strict();
const input = z.object({ name: z.string(), document: documentSchema, currentDocument: documentSchema.optional(), target, replacement: z.string(), instruction: z.string().max(2000) }).strict();
const expected = z.object({ outcome: z.enum(['applied','rejected']), errorIncludes: z.string().optional(), finalText: z.string().optional() }).strict();
const manifestSchema = z.object({ suiteKey: z.literal('structured-document-editing'), suiteVersion: z.string(), cases: z.array(z.object({ id: z.string(), caseVersion: z.string(), fixture: z.string(), expected: z.string(), inputSha256: z.string().length(64), expectedSha256: z.string().length(64), tags: z.array(z.string()) }).strict()).min(8).max(50) }).strict();
export interface DocumentCorpusCase { id: string; caseVersion: string; tags: string[]; inputHash: string; expectedHash: string; input: z.infer<typeof input> }
async function readPinned(file: string, digest: string, directory: string): Promise<unknown> {
  const location = path.resolve(path.dirname(manifestPath),file);
  if (!location.startsWith(directory + path.sep)) throw new Error('DOCUMENT_CORPUS_PATH_INVALID');
  const bytes=await readFile(location); if(createHash('sha256').update(bytes).digest('hex')!==digest)throw new Error('DOCUMENT_CORPUS_HASH_MISMATCH');
  return JSON.parse(bytes.toString('utf8')) as unknown;
}
export async function loadDocumentCorpus() {
  const manifest=manifestSchema.parse(JSON.parse(await readFile(manifestPath,'utf8')));
  if(new Set(manifest.cases.map((item)=>item.id)).size!==manifest.cases.length)throw new Error('DOCUMENT_CORPUS_DUPLICATE_CASE');
  const cases:DocumentCorpusCase[]=[];
  for(const entry of manifest.cases){
    const value=input.parse(await readPinned(entry.fixture,entry.inputSha256,path.join(root,'suites/document-editing')));
    validateDocument(value.document);if(value.currentDocument)validateDocument(value.currentDocument);
    // Hash-check hidden bytes now; reveal their parsed values only to the scorer.
    await readPinned(entry.expected,entry.expectedSha256,path.join(root,'hidden/document-editing'));
    cases.push({id:entry.id,caseVersion:entry.caseVersion,tags:entry.tags,inputHash:entry.inputSha256,expectedHash:entry.expectedSha256,input:value});
  }
  return {manifest,cases};
}
export async function loadDocumentExpected(id:string){
  const manifest=manifestSchema.parse(JSON.parse(await readFile(manifestPath,'utf8')));const item=manifest.cases.find((entry)=>entry.id===id);if(!item)throw new Error('DOCUMENT_CORPUS_CASE_MISSING');
  return expected.parse(await readPinned(item.expected,item.expectedSha256,path.join(root,'hidden/document-editing')));
}
export function cloneCorpusDocument(document:ProserDocument):ProserDocument{return structuredClone(document);}
