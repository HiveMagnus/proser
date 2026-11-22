import { describe, expect, it } from 'vitest';
import { ownedCanvasImageSource } from '../canvas-adapter';

describe('owned Canvas image sources', () => {
  const image = {
    value: '/api/images/42/content',
    extension: { proser: { kind: 'inlineImage', assetId: 42, sha256: 'a'.repeat(64) } },
  };
  it('requires exact owned URL, immutable digest and verified identity', () => {
    expect(ownedCanvasImageSource(image)).toBe(true);
    for (const value of [
      'https://external.invalid/image.png',
      'data:image/png;base64,a',
      'blob:random',
      '/api/images/42/content?external=1',
      '//external.invalid/image.png',
    ])
      expect(ownedCanvasImageSource({ ...image, value })).toBe(false);
    expect(ownedCanvasImageSource({ value: image.value })).toBe(false);
    expect(
      ownedCanvasImageSource({
        ...image,
        extension: { proser: { kind: 'inlineImage', assetId: 42, sha256: 'bad' } },
      }),
    ).toBe(false);
  });
});
