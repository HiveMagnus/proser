import { createHash } from 'node:crypto';
import fixtures from '../fixtures/owned-image-headers.json';
import { inspectImageMetadata } from '@/lib/imageMetadata';

test.each(fixtures)('registers exact bounded $type dimensions and digest from independently encoded bytes', ({ type, base64 }) => {
  const bytes = Buffer.from(base64, 'base64');
  expect(inspectImageMetadata(bytes)).toEqual({ mediaType: type, width: 37, height: 19, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
});
test('rejects excessive dimensions, truncated JPEG segments and unsupported bytes', () => {
  const png = Buffer.from(fixtures[0].base64, 'base64'); png.writeUInt32BE(17000,16); expect(() => inspectImageMetadata(png)).toThrow('dimensions');
  const jpeg = Buffer.from(fixtures[1].base64, 'base64'); jpeg.writeUInt16BE(1,jpeg.indexOf(Buffer.from([255,192]))+2); expect(() => inspectImageMetadata(jpeg)).toThrow();
  expect(() => inspectImageMetadata(Buffer.from('not an image'))).toThrow('Only PNG');
});
test('WebP chunk limits, exact canvas/frame agreement and animation fence hold before decoding', () => {
  const source = Buffer.from(fixtures[2].base64, 'base64'); const start = source.indexOf(Buffer.from('VP8X'))+8;
  const dimensions = Buffer.from(source); dimensions.writeUIntLE(38,start+4,3); expect(() => inspectImageMetadata(dimensions)).toThrow('canvas');
  const animation = Buffer.from(source); animation[start] |= 2; expect(() => inspectImageMetadata(animation)).toThrow('extended');
  const truncated = Buffer.from(source); truncated.writeUInt32LE(0xffffffff,16); expect(() => inspectImageMetadata(truncated)).toThrow('bounds');
  expect(() => inspectImageMetadata(source.subarray(0,source.length-1))).toThrow('container size');
});
