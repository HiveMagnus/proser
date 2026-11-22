import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('ProserAuthor deployment secret controls', () => {
  it('protects the active web environment and removes retired environment files', () => {
    const deploy = readFileSync(
      resolve(process.cwd(), '../../scripts/deploy-to-proser.sh'),
      'utf8',
    );
    expect(deploy).toContain("rm -f -- '$REMOTE_DIR/.env.api' '$REMOTE_DIR/.env.worker'");
    expect(deploy).toContain("chmod 0600 '$REMOTE_DIR/.env.web'");
    expect(deploy).toContain("stat -c '%a' '$REMOTE_DIR/.env.web'");
  });

  it('keeps the sudo credential out of SSH process arguments', () => {
    const deploy = readFileSync(
      resolve(process.cwd(), '../../scripts/deploy-to-proser.sh'),
      'utf8',
    );
    expect(deploy).toContain(`printf '%s\\n' "$SUDO_PASS" | ssh`);
    expect(deploy).not.toContain("'$ESCAPED_SUDO_PASS'");
  });

  it('verifies TLS for public and loopback deployment checks', () => {
    const scripts = [
      readFileSync(resolve(process.cwd(), '../../scripts/deploy-to-proser.sh'), 'utf8'),
      readFileSync(resolve(process.cwd(), '../../deploy/update.sh'), 'utf8'),
    ];
    for (const script of scripts) {
      expect(script).not.toMatch(/curl[^\n]*\s-[A-Za-z]*k[A-Za-z]*/);
      expect(script).not.toContain('--insecure');
      expect(script).not.toContain('https://localhost');
      expect(script).toMatch(/--resolve "?\$CANONICAL_HOST:443:127\.0\.0\.1/);
    }
  });

  it('keeps unauthenticated development data services on loopback', () => {
    const compose = readFileSync(
      resolve(process.cwd(), '../../infra/docker/docker-compose.yml'),
      'utf8',
    );
    for (const port of ['6333', '6334', '6379']) {
      expect(compose).toContain(`127.0.0.1:${port}:${port}`);
      expect(compose).not.toMatch(new RegExp(`-[ \\t]+["']?${port}:${port}`));
    }
  });
});
