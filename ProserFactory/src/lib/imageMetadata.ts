import { createHash } from 'node:crypto';
import { ValidationError } from './errors';

/** Inspect bounded headers without decoding attacker-controlled pixels. WebP
 * layout follows https://developers.google.com/speed/webp/docs/riff_container. */
export function inspectImageMetadata(bytes: Buffer) {
  if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new ValidationError('Image bytes exceed supported bounds');
  let width = 0; let height = 0; let mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  if (bytes.length >= 33 && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) && bytes.toString('ascii',12,16) === 'IHDR') {
    if (bytes.readUInt32BE(8) !== 13) throw new ValidationError('Invalid PNG header');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); mediaType = 'image/png';
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[bytes.length-2] === 255 && bytes[bytes.length-1] === 217) {
    mediaType = 'image/jpeg'; let offset = 2; let markers = 0;
    while (offset + 4 <= bytes.length && markers++ < 10000) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 218 || marker === 217 || marker === undefined) break;
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) {
        if (length < 8 || length !== 8 + 3 * bytes[offset+7]) break;
        height = bytes.readUInt16BE(offset+3); width = bytes.readUInt16BE(offset+5); break;
      }
      offset += length;
    }
  } else if (bytes.length >= 20 && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') {
    mediaType = 'image/webp';
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw new ValidationError('WebP container size differs from its bytes');
    let offset = 12; let chunks = 0; let decodedWidth = 0; let decodedHeight = 0;
    while (offset < bytes.length && chunks++ < 10000) {
      if (offset + 8 > bytes.length) throw new ValidationError('Truncated WebP chunk');
      const kind = bytes.toString('ascii',offset,offset+4); const size = bytes.readUInt32LE(offset+4); const start = offset+8; const end = start+size;
      if (end + (size % 2) > bytes.length || size % 2 && bytes[end] !== 0) throw new ValidationError('Invalid WebP chunk bounds');
      if (kind === 'ANIM' || kind === 'ANMF') throw new ValidationError('Animated WebP requires an explicit supported conversion');
      if (kind === 'VP8X') {
        if (size !== 10 || bytes[start] & 2) throw new ValidationError('Unsupported extended WebP header');
        width = bytes.readUIntLE(start+4,3)+1; height = bytes.readUIntLE(start+7,3)+1;
      } else if (kind === 'VP8L') {
        if (size < 5 || bytes[start] !== 47 || bytes[start+4] & 224) throw new ValidationError('Invalid lossless WebP header');
        decodedWidth = 1 + (bytes[start+1] | (bytes[start+2] & 63) << 8);
        decodedHeight = 1 + ((bytes[start+2] >> 6) | bytes[start+3] << 2 | (bytes[start+4] & 15) << 10);
      } else if (kind === 'VP8 ') {
        if (size < 10 || bytes[start] & 1 || bytes.toString('hex',start+3,start+6) !== '9d012a') throw new ValidationError('Invalid lossy WebP frame');
        decodedWidth = bytes.readUInt16LE(start+6) & 16383; decodedHeight = bytes.readUInt16LE(start+8) & 16383;
      }
      offset = end + size % 2;
    }
    if (offset !== bytes.length || !decodedWidth || !decodedHeight || width && (width !== decodedWidth || height !== decodedHeight)) throw new ValidationError('WebP canvas and frame dimensions are invalid');
    width ||= decodedWidth; height ||= decodedHeight;
  } else throw new ValidationError('Only PNG, JPEG and static WebP images are supported');
  if (!width || !height || width > 16384 || height > 16384 || width * height > 64_000_000) throw new ValidationError('Image dimensions exceed supported bounds');
  return { sha256: createHash('sha256').update(bytes).digest('hex'), mediaType, byteLength: bytes.length, width, height };
}
