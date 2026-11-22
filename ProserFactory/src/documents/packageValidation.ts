import { WordCodecError, crc32 as codecCrc32, readDocumentPackage as codecReadPackage, parseDocumentXml as codecParseXml, validateDocxPackage as codecValidateDocx } from '@hivemagnus/canvas-word-codec';
import { DocumentError } from './errors';
function translate(error: unknown): never { if (error instanceof WordCodecError) throw new DocumentError(error.code,error.message,error.status,error.details); throw error; }
export const crc32 = codecCrc32;
export async function readDocumentPackage(bytes: Buffer, generated = false) { try { return await codecReadPackage(bytes,generated); } catch(error) { return translate(error); } }
export function parseDocumentXml(bytes: Buffer) { try { return codecParseXml(bytes); } catch(error) { return translate(error); } }
export async function validateDocxPackage(bytes: Buffer, generated = false) { try { return await codecValidateDocx(bytes,generated); } catch(error) { return translate(error); } }
