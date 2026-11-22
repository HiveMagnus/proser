/// <reference types="jest" />
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../index';
import { databaseService } from '../lib/database';

describe('JWT identity recovery for existing users', () => {
  const originalHermesSecret = process.env.HERMES_AGENT_AUTH_SECRET;
  const originalHermesGithubId = process.env.HERMES_AGENT_GITHUB_ID;
  const originalHermesAllowedGithubIds = process.env.HERMES_AGENT_ALLOWED_GITHUB_IDS;
  const originalHermesGithubIds = process.env.HERMES_AGENT_GITHUB_IDS;
  const originalHermesOwnerGithubIds = process.env.HERMES_AGENT_ALLOWED_OWNER_GITHUB_IDS;
  const originalHermesIssuer = process.env.HERMES_AGENT_ISSUER;
  const originalLegacyOptIn = process.env.ALLOW_LEGACY_AUTH_SECRETS;

  afterEach(() => {
    if (originalHermesSecret === undefined) delete process.env.HERMES_AGENT_AUTH_SECRET;
    else process.env.HERMES_AGENT_AUTH_SECRET = originalHermesSecret;

    if (originalHermesGithubId === undefined) delete process.env.HERMES_AGENT_GITHUB_ID;
    else process.env.HERMES_AGENT_GITHUB_ID = originalHermesGithubId;

    if (originalHermesAllowedGithubIds === undefined) delete process.env.HERMES_AGENT_ALLOWED_GITHUB_IDS;
    else process.env.HERMES_AGENT_ALLOWED_GITHUB_IDS = originalHermesAllowedGithubIds;

    if (originalHermesGithubIds === undefined) delete process.env.HERMES_AGENT_GITHUB_IDS;
    else process.env.HERMES_AGENT_GITHUB_IDS = originalHermesGithubIds;

    if (originalHermesOwnerGithubIds === undefined) delete process.env.HERMES_AGENT_ALLOWED_OWNER_GITHUB_IDS;
    else process.env.HERMES_AGENT_ALLOWED_OWNER_GITHUB_IDS = originalHermesOwnerGithubIds;

    if (originalHermesIssuer === undefined) delete process.env.HERMES_AGENT_ISSUER;
    else process.env.HERMES_AGENT_ISSUER = originalHermesIssuer;

    if (originalLegacyOptIn === undefined) delete process.env.ALLOW_LEGACY_AUTH_SECRETS;
    else process.env.ALLOW_LEGACY_AUTH_SECRETS = originalLegacyOptIn;
  });

  it('accepts the dedicated Hermes agent secret only for the Hermes service identity', async () => {
    process.env.HERMES_AGENT_AUTH_SECRET = 'jest-hermes-agent-secret';
    process.env.HERMES_AGENT_GITHUB_ID = 'service:hermes-agent';
    process.env.HERMES_AGENT_ISSUER = 'hermes-agent';

    const token = jwt.sign({
      iss: 'hermes-agent',
      aud: 'proser-factory',
      sub: 'service:hermes-agent',
      githubId: 'service:hermes-agent',
      username: 'hermes-agent',
    }, process.env.HERMES_AGENT_AUTH_SECRET, { algorithm: 'HS256', expiresIn: '10m' });

    const res = await request(app)
      .get('/api/books')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    await databaseService.client.user.deleteMany({ where: { githubId: 'service:hermes-agent' } });
  });

  it('accepts dedicated Hermes tokens for identities on the allowlist', async () => {
    process.env.HERMES_AGENT_AUTH_SECRET = 'jest-hermes-agent-secret';
    process.env.HERMES_AGENT_GITHUB_ID = 'service:hermes-agent';
    process.env.HERMES_AGENT_ALLOWED_GITHUB_IDS = 'service:hermes-agent, service:hermes-agent:agent-host';
    process.env.HERMES_AGENT_ISSUER = 'hermes-agent';

    const token = jwt.sign({
      iss: 'hermes-agent',
      aud: 'proser-factory',
      sub: 'service:hermes-agent:agent-host',
      githubId: 'service:hermes-agent:agent-host',
      username: 'hermes-agent-agent-host',
    }, process.env.HERMES_AGENT_AUTH_SECRET, { algorithm: 'HS256', expiresIn: '10m' });

    const res = await request(app)
      .get('/api/books')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    await databaseService.client.user.deleteMany({ where: { githubId: 'service:hermes-agent:agent-host' } });
  });

  it('allows an allow-listed Hermes actor to work on behalf of an existing author', async () => {
    process.env.HERMES_AGENT_AUTH_SECRET = 'jest-hermes-agent-secret';
    process.env.HERMES_AGENT_GITHUB_ID = 'service:hermes-agent';
    process.env.HERMES_AGENT_ALLOWED_OWNER_GITHUB_IDS = 'jest-owner:author';
    process.env.HERMES_AGENT_ISSUER = 'hermes-agent';
    const owner = await databaseService.client.user.create({ data: { githubId: 'jest-owner:author', username: 'author' } });
    const book = await databaseService.client.book.create({ data: { userId: owner.id, title: 'Delegated Book' } });
    const token = jwt.sign({
      iss: 'hermes-agent', aud: 'proser-factory', sub: 'service:hermes-agent',
      githubId: 'service:hermes-agent', username: 'hermes-agent', ownerGithubId: owner.githubId,
    }, process.env.HERMES_AGENT_AUTH_SECRET, { algorithm: 'HS256', expiresIn: '10m' });

    const res = await request(app).get('/api/books').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.books.some((entry: { id: number }) => entry.id === book.id)).toBe(true);
    await databaseService.client.user.delete({ where: { id: owner.id } });
    await databaseService.client.user.deleteMany({ where: { githubId: 'service:hermes-agent' } });
  });

  it('rejects Hermes owner delegation that is not explicitly allow-listed', async () => {
    process.env.HERMES_AGENT_AUTH_SECRET = 'jest-hermes-agent-secret';
    process.env.HERMES_AGENT_GITHUB_ID = 'service:hermes-agent';
    delete process.env.HERMES_AGENT_ALLOWED_OWNER_GITHUB_IDS;
    process.env.HERMES_AGENT_ISSUER = 'hermes-agent';
    const token = jwt.sign({
      iss: 'hermes-agent', aud: 'proser-factory', sub: 'service:hermes-agent',
      githubId: 'service:hermes-agent', username: 'hermes-agent', ownerGithubId: 'jest-owner:author',
    }, process.env.HERMES_AGENT_AUTH_SECRET, { algorithm: 'HS256', expiresIn: '10m' });
    const res = await request(app).get('/api/books').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it.each([
    ['missing', undefined],
    ['wrong', 'another-service'],
  ])('rejects Hermes tokens with %s audience', async (_label, audience) => {
    process.env.HERMES_AGENT_AUTH_SECRET = 'jest-hermes-agent-secret';
    process.env.HERMES_AGENT_GITHUB_ID = 'service:hermes-agent';
    process.env.HERMES_AGENT_ISSUER = 'hermes-agent';
    const payload: Record<string, string> = {
      iss: 'hermes-agent', sub: 'service:hermes-agent', githubId: 'service:hermes-agent', username: 'hermes-agent',
    };
    if (audience) payload.aud = audience;
    const token = jwt.sign(payload, process.env.HERMES_AGENT_AUTH_SECRET, { algorithm: 'HS256', expiresIn: '10m' });
    const res = await request(app).get('/api/books').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('resolves service-style Hermes subjects before scene prose persistence', async () => {
    process.env.HERMES_AGENT_AUTH_SECRET = 'jest-hermes-agent-secret';
    process.env.HERMES_AGENT_GITHUB_ID = 'service:hermes-agent';
    process.env.HERMES_AGENT_ALLOWED_GITHUB_IDS = 'service:hermes-agent, jest-service:hermes-agent:agent-host';
    process.env.HERMES_AGENT_ISSUER = 'hermes-agent';

    const githubId = 'jest-service:hermes-agent:agent-host';
    await databaseService.client.user.deleteMany({ where: { githubId } });

    const token = jwt.sign({
      iss: 'hermes-agent',
      aud: 'proser-factory',
      sub: githubId,
      username: 'hermes-agent-agent-host',
    }, process.env.HERMES_AGENT_AUTH_SECRET, { algorithm: 'HS256', expiresIn: '10m' });
    const auth = (req: request.Test): request.Test => req.set('Authorization', `Bearer ${token}`);

    const createdBook = await auth(request(app).post('/api/books')).send({
      title: 'Hermes Persistence Fixture',
      genre: 'paranormal',
      targetAudience: 'adult',
      summary: 'A compact fixture for service identity scene persistence.',
    });
    expect(createdBook.status).toBe(201);
    const bookId = createdBook.body.data.id as number;

    const structure = await auth(request(app).post(`/api/books/${bookId}/structure`)).send({
      acts: [
        {
          title: 'Act One',
          summary: 'Opening movement',
          chapters: [{ title: 'Chapter One', summary: 'Archive rain' }],
        },
      ],
    });
    expect(structure.status).toBe(201);
    const chapterId = structure.body.data.acts[0].chapters[0].id as number;

    const scene = await auth(request(app).post(`/api/books/${bookId}/chapters/${chapterId}/scenes`)).send({
      outline: 'Mira finds a warm book in the archive.',
      summary: 'The archive answers the storm.',
    });
    expect(scene.status).toBe(201);
    const sceneId = scene.body.data.scene.id as number;

    const updated = await auth(request(app).put(`/api/books/${bookId}/scenes/${sceneId}`)).send({
      prose: "The rain hammered the archive windows while the book warmed beneath Mira's hand.",
    });
    expect(updated.status).toBe(200);
    expect(updated.body.data.scene.wordCount).toBeGreaterThan(0);

    const serviceUser = await databaseService.client.user.findUnique({ where: { githubId } });
    expect(serviceUser?.id).toEqual(expect.any(Number));
    expect(serviceUser?.username).toBe('hermes-agent-agent-host');

    const persistedScene = await databaseService.client.scene.findUnique({ where: { id: sceneId } });
    expect(persistedScene?.prose).toContain('book warmed');

    await databaseService.client.user.deleteMany({ where: { githubId } });
  });

  it('rejects Hermes-secret tokens that try to impersonate a different identity', async () => {
    process.env.HERMES_AGENT_AUTH_SECRET = 'jest-hermes-agent-secret';
    process.env.HERMES_AGENT_GITHUB_ID = 'service:hermes-agent';
    delete process.env.HERMES_AGENT_ALLOWED_GITHUB_IDS;
    process.env.HERMES_AGENT_ISSUER = 'hermes-agent';

    const token = jwt.sign({
      iss: 'hermes-agent',
      aud: 'proser-factory',
      sub: 'not-hermes',
      githubId: 'not-hermes',
      username: 'not-hermes',
    }, process.env.HERMES_AGENT_AUTH_SECRET, { algorithm: 'HS256', expiresIn: '10m' });

    const res = await request(app)
      .get('/api/books')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('recovers books when githubId shape changes and IAM sends an email-style username', async () => {
    process.env.ALLOW_LEGACY_AUTH_SECRETS = 'true';
    await databaseService.client.user.deleteMany({ where: { githubId: 'iam:proser-test-recovery@magnus.local' } });

    const legacyUser = await databaseService.client.user.upsert({
      where: { githubId: 'legacy-proser-test-recovery' },
      update: { username: 'proser-test-recovery' },
      create: {
        githubId: 'legacy-proser-test-recovery',
        username: 'proser-test-recovery',
        email: 'proser-test-recovery@example.com',
      },
    });

    const book = await databaseService.client.book.create({
      data: {
        userId: legacyUser.id,
        title: 'Recovered Project',
        genre: 'horror',
        summary: 'Should still be visible after auth identity changes.',
      },
    });

    const secret = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET || '';
    expect(secret).toBeTruthy();

    const token = jwt.sign({
      sub: '999999',
      githubId: 'iam:proser-test-recovery@magnus.local',
      username: 'proser-test-recovery@magnus.local',
      email: 'proser-test-recovery@magnus.local',
    }, secret, { algorithm: 'HS256', expiresIn: '10m' });

    const res = await request(app)
      .get('/api/books')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.books.some((entry: any) => entry.id === book.id)).toBe(true);

    const updated = await databaseService.client.user.findUnique({ where: { id: legacyUser.id } });
    expect(updated?.githubId).toBe('iam:proser-test-recovery@magnus.local');
    expect(updated?.username).toBe('proser-test-recovery');

    await databaseService.client.book.deleteMany({ where: { id: book.id } });
    await databaseService.client.user.deleteMany({ where: { githubId: 'iam:proser-test-recovery@magnus.local' } });
    await databaseService.client.user.deleteMany({ where: { id: legacyUser.id } });
  });

  it('ignores a colliding numeric sub when the provider identity points at another user', async () => {
    process.env.ALLOW_LEGACY_AUTH_SECRETS = 'true';
    const unrelatedUser = await databaseService.client.user.upsert({
      where: { githubId: 'legacy-other-user' },
      update: { username: 'other-user' },
      create: { githubId: 'legacy-other-user', username: 'other-user', email: 'other@example.com' },
    });

    const legacyUser = await databaseService.client.user.upsert({
      where: { githubId: 'legacy-proser-test-collision' },
      update: { username: 'proser-test-collision' },
      create: {
        githubId: 'legacy-proser-test-collision',
        username: 'proser-test-collision',
        email: 'proser-test-collision@example.com',
      },
    });

    const book = await databaseService.client.book.create({
      data: {
        userId: legacyUser.id,
        title: 'Recovered Collision Project',
        genre: 'horror',
        summary: 'Should still be visible when upstream sub collides with another local id.',
      },
    });

    const secret = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET || '';
    expect(secret).toBeTruthy();

    const token = jwt.sign({
      sub: String(unrelatedUser.id),
      githubId: 'iam:proser-test-collision',
      username: 'proser-test-collision',
      email: 'proser-test-collision@example.com',
    }, secret, { algorithm: 'HS256', expiresIn: '10m' });

    const res = await request(app)
      .get('/api/books')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.books.some((entry: any) => entry.id === book.id)).toBe(true);

    await databaseService.client.book.deleteMany({ where: { id: book.id } });
    await databaseService.client.user.deleteMany({ where: { id: legacyUser.id } });
    await databaseService.client.user.deleteMany({ where: { id: unrelatedUser.id } });
  });
});
