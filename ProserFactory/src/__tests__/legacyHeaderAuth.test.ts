/// <reference types="jest" />
import { legacyHeaderAuthEnabled } from '../api/middleware/auth';

describe('legacy header authentication gate', () => {
  it('is available to the automated test runner', () => {
    expect(legacyHeaderAuthEnabled({ NODE_ENV: 'test' })).toBe(true);
  });

  it('requires an explicit opt-in during local development', () => {
    expect(legacyHeaderAuthEnabled({ NODE_ENV: 'development' })).toBe(false);
    expect(legacyHeaderAuthEnabled({ NODE_ENV: 'development', ALLOW_LEGACY_HEADER_AUTH: 'true' })).toBe(true);
    expect(legacyHeaderAuthEnabled({ NODE_ENV: 'development', ALLOW_LEGACY_HEADER_AUTH: '1' })).toBe(false);
  });

  it.each([undefined, '', 'production', 'prod', 'staging', 'Production'])(
    'stays closed when NODE_ENV is %p, even with the opt-in',
    (nodeEnv) => {
      expect(legacyHeaderAuthEnabled({ NODE_ENV: nodeEnv, ALLOW_LEGACY_HEADER_AUTH: 'true' })).toBe(false);
    },
  );
});
