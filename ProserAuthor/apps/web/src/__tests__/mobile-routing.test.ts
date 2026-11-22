import { describe, expect, it } from 'vitest';

import { getMobileRoute, isPhoneUserAgent, shouldRedirectToMobile } from '@/lib/mobile-routing';

describe('mobile routing helpers', () => {
  it('detects phone-class user agents without treating tablets as phones', () => {
    expect(isPhoneUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(true);
    expect(isPhoneUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit Mobile')).toBe(
      true,
    );
    expect(isPhoneUserAgent('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe(false);
  });

  it('maps supported desktop routes into the mobile route space', () => {
    expect(getMobileRoute('/')).toBe('/m');
    expect(getMobileRoute('/manuscript')).toBe('/m/studio');
    expect(getMobileRoute('/chat')).toBe('/m/not-found');
    expect(getMobileRoute('/plot')).toBe('/m/plot');
    expect(getMobileRoute('/editorial')).toBe('/m/editorial');
    expect(getMobileRoute('/publish')).toBe('/m/read');
  });

  it('respects the persistent desktop override cookie', () => {
    expect(
      shouldRedirectToMobile({
        pathname: '/',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        preference: 'desktop',
      }),
    ).toBe(false);

    expect(
      shouldRedirectToMobile({
        pathname: '/',
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        preference: 'auto',
      }),
    ).toBe(true);
  });
});
