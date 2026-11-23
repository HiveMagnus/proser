/// <reference types="jest" />
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../index';
import { databaseService } from '../lib/database';
import { clearSessionRevocationCacheForTests } from '../api/middleware/auth';

const IDENTITY = 'local:jest-session-revocation';
function sessionToken(sessionIssuedAt?: number) {
  return jwt.sign(
    { sub: IDENTITY, githubId: IDENTITY, username: 'session-fixture', ...(sessionIssuedAt === undefined ? {} : { sessionIssuedAt }) },
    'jest-factory-auth-secret',
    { algorithm: 'HS256', issuer: 'proser-author', audience: 'proser-factory', expiresIn: '5m' },
  );
}
const call = (method: 'get' | 'post', path: string, token: string) => request(app)[method](path).set('Authorization', `Bearer ${token}`);

describe('session revocation', () => {
  const previousHermes = { secret: process.env.HERMES_AGENT_AUTH_SECRET, owners: process.env.HERMES_AGENT_ALLOWED_OWNER_GITHUB_IDS };
  const previousFactorySecret = process.env.FACTORY_AUTH_SECRET;
  beforeAll(() => { process.env.FACTORY_AUTH_SECRET = 'jest-factory-auth-secret'; });
  afterAll(async () => {
    if (previousFactorySecret === undefined) delete process.env.FACTORY_AUTH_SECRET; else process.env.FACTORY_AUTH_SECRET = previousFactorySecret;
    for (const [key, value] of [['HERMES_AGENT_AUTH_SECRET', previousHermes.secret], ['HERMES_AGENT_ALLOWED_OWNER_GITHUB_IDS', previousHermes.owners]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await databaseService.client.user.deleteMany({ where: { githubId: { in: [IDENTITY, 'service:hermes-agent'] } } });
  });

  it('refuses sessions signed in before the revocation and accepts later ones', async () => {
    const signedInAt = Math.floor(Date.now() / 1000) - 600;
    const stolen = sessionToken(signedInAt);
    const unstamped = sessionToken();
    expect((await call('get', '/api/books', stolen)).status).toBe(200);
    expect((await call('get', '/api/books', unstamped)).status).toBe(200);

    const revoked = await call('post', '/api/settings/sessions/revoke', stolen);
    expect(revoked.status).toBe(200);
    expect(Date.parse(revoked.body.data.revokedBefore)).toBeGreaterThan(signedInAt * 1000);

    const refused = await call('get', '/api/books', stolen);
    expect(refused.status).toBe(401);
    expect(refused.body.error.details).toEqual({ code: 'SESSION_REVOKED' });
    expect((await call('get', '/api/books', unstamped)).status).toBe(401);
    expect((await call('get', '/api/books', sessionToken(Math.floor(Date.now() / 1000) + 2))).status).toBe(200);

    // Another Factory process learns of the revocation from the database.
    clearSessionRevocationCacheForTests();
    expect((await call('get', '/api/books', stolen)).status).toBe(401);
  });

  it('does not let a delegated agent revoke its owner and leaves agent tokens unaffected', async () => {
    process.env.HERMES_AGENT_AUTH_SECRET = 'jest-hermes-agent-secret';
    process.env.HERMES_AGENT_ALLOWED_OWNER_GITHUB_IDS = IDENTITY;
    const agent = jwt.sign(
      { sub: 'service:hermes-agent', githubId: 'service:hermes-agent', username: 'hermes-agent', ownerGithubId: IDENTITY },
      'jest-hermes-agent-secret',
      { algorithm: 'HS256', issuer: 'hermes-agent', audience: 'proser-factory', expiresIn: '5m' },
    );
    expect((await call('get', '/api/books', agent)).status).toBe(200);
    expect((await call('post', '/api/settings/sessions/revoke', agent)).status).toBe(403);
  });
});
