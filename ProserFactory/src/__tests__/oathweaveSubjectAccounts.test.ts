/// <reference types="jest" />
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../index';
import { databaseService } from '../lib/database';

const SECRET = 'jest-factory-auth-secret';
const PREFIX = 'jest-oidc-';

function authorToken(claims: Record<string, unknown>, secret = SECRET, issuer = 'proser-author') {
  return jwt.sign(claims, secret, { algorithm: 'HS256', issuer, audience: 'proser-factory', expiresIn: '5m' });
}
const oidcToken = (username: string, subject: string) =>
  authorToken({ sub: `iam:${username}`, githubId: `iam:${username}`, username, oathweaveSubject: subject });
const relayToken = (username: string) => authorToken({ sub: `iam:${username}`, githubId: `iam:${username}`, username });
const books = (token: string) => request(app).get('/api/books').set('Authorization', `Bearer ${token}`);

async function createBook(token: string, title: string) {
  const response = await request(app).post('/api/books').set('Authorization', `Bearer ${token}`).send({ title });
  expect(response.status).toBeLessThan(300);
}
const titles = (response: request.Response): string[] =>
  (response.body.data?.books ?? response.body.data ?? []).map((book: { title: string }) => book.title);

describe('Oathweave OIDC accounts', () => {
  const previous = { secret: process.env.FACTORY_AUTH_SECRET, hermes: process.env.HERMES_AGENT_AUTH_SECRET };
  const prisma = () => databaseService.client;
  const cleanup = async () => {
    const users = await prisma().user.findMany({
      where: { OR: [{ username: { startsWith: PREFIX } }, { oathweaveSubject: { startsWith: PREFIX } }] },
      select: { id: true },
    });
    const ids = users.map((user) => user.id);
    if (!ids.length) return;
    await prisma().book.deleteMany({ where: { userId: { in: ids } } });
    await prisma().user.deleteMany({ where: { id: { in: ids } } });
  };
  beforeAll(async () => {
    process.env.FACTORY_AUTH_SECRET = SECRET;
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    if (previous.secret === undefined) delete process.env.FACTORY_AUTH_SECRET; else process.env.FACTORY_AUTH_SECRET = previous.secret;
    if (previous.hermes === undefined) delete process.env.HERMES_AGENT_AUTH_SECRET; else process.env.HERMES_AGENT_AUTH_SECRET = previous.hermes;
  });

  it('links the first OIDC sign-in to the password-relay account with the same username', async () => {
    const username = `${PREFIX}linked`;
    await createBook(relayToken(username), 'Relay manuscript');
    const relayUser = await prisma().user.findUniqueOrThrow({ where: { githubId: `iam:${username}` } });
    expect(relayUser.oathweaveSubject).toBeNull();

    const signedIn = await books(oidcToken(username, `${PREFIX}subject-linked`));
    expect(signedIn.status).toBe(200);
    expect(titles(signedIn)).toContain('Relay manuscript');

    const linked = await prisma().user.findUniqueOrThrow({ where: { id: relayUser.id } });
    expect(linked.oathweaveSubject).toBe(`${PREFIX}subject-linked`);
    // The handle is kept, so the relay fallback still reaches the same account.
    expect(linked.githubId).toBe(`iam:${username}`);
    expect(titles(await books(relayToken(username)))).toContain('Relay manuscript');
    expect(await prisma().user.count({ where: { username } })).toBe(1);
  });

  it('keys later sign-ins on the subject even after the Oathweave username changes', async () => {
    const username = `${PREFIX}before-rename`;
    const subject = `${PREFIX}subject-rename`;
    await createBook(oidcToken(username, subject), 'Kept across rename');
    const renamed = await books(oidcToken(`${PREFIX}after-rename`, subject));
    expect(renamed.status).toBe(200);
    expect(titles(renamed)).toContain('Kept across rename');
    expect(await prisma().user.count({ where: { oathweaveSubject: subject } })).toBe(1);
    expect(await prisma().user.count({ where: { githubId: `iam:${PREFIX}after-rename` } })).toBe(0);
  });

  it('gives a new Oathweave user a new account', async () => {
    const username = `${PREFIX}newcomer`;
    const response = await books(oidcToken(username, `${PREFIX}subject-new`));
    expect(response.status).toBe(200);
    expect(titles(response)).toEqual([]);
    const created = await prisma().user.findUniqueOrThrow({ where: { oathweaveSubject: `${PREFIX}subject-new` } });
    expect(created.githubId).toBe(`iam:${username}`);
  });

  it('never hands an account linked to one subject to another subject with the same username', async () => {
    const username = `${PREFIX}reused`;
    await createBook(oidcToken(username, `${PREFIX}subject-original`), 'Original owner');
    const other = await books(oidcToken(username, `${PREFIX}subject-other`));
    expect(other.status).toBe(200);
    expect(titles(other)).not.toContain('Original owner');
    const separate = await prisma().user.findUniqueOrThrow({ where: { oathweaveSubject: `${PREFIX}subject-other` } });
    expect(separate.githubId).toBe(`oathweave:${PREFIX}subject-other`);
    expect(titles(await books(oidcToken(username, `${PREFIX}subject-original`)))).toContain('Original owner');
  });

  it('leaves tokens without a subject (local accounts, relay) resolving by handle', async () => {
    const username = `${PREFIX}local`;
    const local = authorToken({ sub: `iam:${username}`, githubId: `iam:${username}`, username });
    await createBook(local, 'Local manuscript');
    expect(titles(await books(local))).toContain('Local manuscript');
    const user = await prisma().user.findUniqueOrThrow({ where: { githubId: `iam:${username}` } });
    expect(user.oathweaveSubject).toBeNull();
  });

  it('ignores a subject claimed by an agent token', async () => {
    process.env.HERMES_AGENT_AUTH_SECRET = 'jest-hermes-agent-secret';
    const agent = authorToken(
      { sub: 'service:hermes-agent', githubId: 'service:hermes-agent', username: 'hermes-agent', oathweaveSubject: `${PREFIX}subject-linked` },
      'jest-hermes-agent-secret',
      'hermes-agent',
    );
    expect((await books(agent)).status).toBe(200);
    const agentUser = await prisma().user.findUniqueOrThrow({ where: { githubId: 'service:hermes-agent' } });
    expect(agentUser.oathweaveSubject).toBeNull();
  });
});
