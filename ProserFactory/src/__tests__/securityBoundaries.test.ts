import fs from 'fs/promises';
import path from 'path';
import request from 'supertest';
import app from '../index';
import { databaseService } from '../lib/database';
import jwt from 'jsonwebtoken';

const prefix = `jest-security-${Date.now()}`;
const authFor = (user: { id: number; githubId: string }) => (test: request.Test) => test
  .set('x-user-id', String(user.id))
  .set('x-github-id', user.githubId)
  .set('x-username', user.githubId);

describe('Workflow and private image security boundaries', () => {
  const files: string[] = [];
  let owner: { id: number; githubId: string };
  let other: { id: number; githubId: string };
  let bookId: number;
  let assetId: number;

  beforeAll(async () => {
    process.env.FACTORY_AUTH_SECRET = 'jest-factory-auth-secret';
    owner = await databaseService.client.user.create({ data: { githubId: `${prefix}-owner`, username: `${prefix}-owner` } });
    other = await databaseService.client.user.create({ data: { githubId: `${prefix}-other`, username: `${prefix}-other` } });
    const book = await databaseService.client.book.create({ data: { userId: owner.id, title: 'Private image fixture' } });
    bookId = book.id;
    const name = `${prefix}.png`;
    const filePath = path.resolve('public/images', name);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    files.push(filePath);
    const asset = await databaseService.client.imageAsset.create({ data: { userId: owner.id, bookId, name, url: `/images/${name}`, source: 'forge' } });
    assetId = asset.id;
  });

  afterAll(async () => {
    await databaseService.client.user.deleteMany({ where: { githubId: { startsWith: prefix } } });
    await Promise.all(files.map((file) => fs.rm(file, { force: true })));
  });

  it('requires auth and strict schemas for workflow routes', async () => {
    expect((await request(app).post('/api/workflows/quality-review')).status).toBe(401);
    expect((await authFor(owner)(request(app).post('/api/workflows/quality-review').send({ bookId: 'bad', scope: { type: 'book' }, model: 'reviewer' }))).status).toBe(400);
    expect((await request(app).get('/api/workflows/00000000-0000-0000-0000-000000000000')).status).toBe(401);
    expect((await authFor(owner)(request(app).post('/api/workflows/full-book').send({ premise: 'short' }))).status).toBe(400);
  });

  it('requires the ProserAuthor issuer and ProserFactory audience on dedicated-secret tokens', async () => {
    const valid = jwt.sign({ sub: String(owner.id), githubId: owner.githubId, username: owner.githubId }, 'jest-factory-auth-secret', {
      algorithm: 'HS256', issuer: 'proser-author', audience: 'proser-factory', expiresIn: '2m',
    });
    const accepted = await request(app).get(`/api/books/${bookId}`).set('Authorization', `Bearer ${valid}`);
    expect(accepted.status).toBe(200);

    const wrongAudience = jwt.sign({ sub: String(owner.id), githubId: owner.githubId }, 'jest-factory-auth-secret', {
      algorithm: 'HS256', issuer: 'proser-author', audience: 'another-service', expiresIn: '2m',
    });
    const rejected = await request(app).get(`/api/books/${bookId}`).set('Authorization', `Bearer ${wrongAudience}`);
    expect(rejected.status).toBe(401);
  });

  it('rejects signed tokens that never expire or outlive the permitted lifetime', async () => {
    const claims = { sub: String(owner.id), githubId: owner.githubId, username: owner.githubId };
    const options = { algorithm: 'HS256', issuer: 'proser-author', audience: 'proser-factory' } as const;
    const withoutExpiry = jwt.sign(claims, 'jest-factory-auth-secret', options);
    expect((await request(app).get(`/api/books/${bookId}`).set('Authorization', `Bearer ${withoutExpiry}`)).status).toBe(401);
    const longLived = jwt.sign(claims, 'jest-factory-auth-secret', { ...options, expiresIn: '30d' });
    expect((await request(app).get(`/api/books/${bookId}`).set('Authorization', `Bearer ${longLived}`)).status).toBe(401);
    const shortLived = jwt.sign(claims, 'jest-factory-auth-secret', { ...options, expiresIn: '10m' });
    expect((await request(app).get(`/api/books/${bookId}`).set('Authorization', `Bearer ${shortLived}`)).status).toBe(200);
  });

  it('never accepts bearer JWTs from query strings, including SSE routes', async () => {
    const valid = jwt.sign(
      { sub: String(owner.id), githubId: owner.githubId, username: owner.githubId },
      'jest-factory-auth-secret',
      {
        algorithm: 'HS256',
        issuer: 'proser-author',
        audience: 'proser-factory',
        expiresIn: '2m',
      },
    );
    expect((await request(app).get(`/api/books/${bookId}`).query({ token: valid })).status).toBe(401);
    expect((await request(app)
      .get('/api/generate/operations/00000000-0000-0000-0000-000000000000/stream')
      .query({ token: valid })).status).toBe(401);
  });

  it('requires authentication for internal prompt templates and rejects unsafe keys', async () => {
    expect((await request(app).get('/api/prompts')).status).toBe(401);
    const listed = await authFor(owner)(request(app).get('/api/prompts'));
    expect(listed.status).toBe(200);
    expect(listed.body.data.prompts).not.toHaveLength(0);
    expect(listed.body.data.prompts).toEqual(expect.arrayContaining([
      expect.objectContaining({ visibility: 'internal' }),
    ]));
    expect(listed.headers['cache-control']).toContain('private');

    const traversal = await authFor(owner)(request(app).get('/api/prompts/%2e%2e%2fsecrets'));
    expect(traversal.status).toBe(404);
    const additional = await authFor(owner)(
      request(app).get('/api/prompts/additional/CHAPTER_OUTLINE_TEMPLATE'),
    );
    expect(additional.status).toBe(200);
    expect(additional.body.data.visibility).toBe('internal');
  });

  it('scopes image listing and content to the authenticated owner', async () => {
    const ownerList = await authFor(owner)(request(app).get('/api/images/list'));
    expect(ownerList.status).toBe(200);
    expect(ownerList.body.data.items).toContainEqual(expect.objectContaining({ id: assetId, url: `/api/images/${assetId}/content` }));
    const otherList = await authFor(other)(request(app).get('/api/images/list'));
    expect(otherList.body.data.items).not.toContainEqual(expect.objectContaining({ id: assetId }));
    expect((await authFor(owner)(request(app).get(`/api/images/${assetId}/content`))).status).toBe(200);
    expect((await authFor(other)(request(app).get(`/api/images/${assetId}/content`))).status).toBe(404);
    expect((await request(app).get(`/images/${prefix}.png`)).status).toBe(404);
  });

  it('does not reveal another user book through image filters or workflow review listings', async () => {
    expect((await authFor(other)(request(app).get('/api/images/list').query({ bookId }))).status).toBe(404);
    expect((await authFor(other)(request(app).get(`/api/books/${bookId}/reviews`))).status).toBe(404);
  });
});
