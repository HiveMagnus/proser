process.env.DATABASE_URL ||= 'postgresql://unused:fixture-only@127.0.0.1:5432/unused_fixture';

import { configSchema, inferenceKeyWarning } from '../../core/config';

const base = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://unused:fixture-only@127.0.0.1:5432/unused_fixture',
};

describe('inference credential configuration', () => {
  it('starts with a keyless inference backend on the Docker host or a private network', () => {
    for (const host of [
      'http://host.docker.internal:11434',
      'http://192.168.1.20:8080',
      'http://ollama:11434',
    ]) {
      const parsed = configSchema.safeParse({ ...base, INFERENCE_HOST: host });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(inferenceKeyWarning(parsed.data)).toMatch(/INFERENCE_API_KEY is not set/);
    }
  });

  it('accepts a provider key of any length unless enforcement is requested', () => {
    expect(configSchema.safeParse({ ...base, INFERENCE_HOST: 'http://gateway:8000', INFERENCE_API_KEY: 'short-key' }).success).toBe(true);
    const enforced = configSchema.safeParse({
      ...base, INFERENCE_HOST: 'http://gateway:8000', INFERENCE_API_KEY: 'short-key', INFERENCE_REQUIRE_API_KEY: 'true',
    });
    expect(enforced.success).toBe(false);
  });

  it('treats an empty key as unset and reports no warning for loopback or keyed backends', () => {
    const loopback = configSchema.parse({ ...base, INFERENCE_HOST: 'http://127.0.0.1:8000', INFERENCE_API_KEY: '' });
    expect(loopback.INFERENCE_API_KEY).toBeUndefined();
    expect(inferenceKeyWarning(loopback)).toBeNull();
    const keyed = configSchema.parse({ ...base, INFERENCE_HOST: 'http://gateway:8000', INFERENCE_API_KEY: 'k'.repeat(40) });
    expect(inferenceKeyWarning(keyed)).toBeNull();
  });

  it('still refuses a keyless remote backend when INFERENCE_REQUIRE_API_KEY=true', () => {
    const parsed = configSchema.safeParse({ ...base, INFERENCE_HOST: 'https://inference.example', INFERENCE_REQUIRE_API_KEY: 'true' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toContain(
        'INFERENCE_API_KEY is required for a non-loopback production inference backend',
      );
    }
    expect(configSchema.safeParse({ ...base, INFERENCE_HOST: 'http://localhost:8000', INFERENCE_REQUIRE_API_KEY: 'true' }).success).toBe(true);
  });
});
