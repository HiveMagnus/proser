import { createHash } from 'node:crypto';
import { canonicalDocument } from './model';
/** Compatibility commands derive a recoverable ID from the exact bound effect.
 * This does not authorize replaying provider inference or publication effects. */
export function compatibilityOperationId(domain: string, value: unknown) {
  const bytes = createHash('sha256').update(`${domain}:${canonicalDocument(value)}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
