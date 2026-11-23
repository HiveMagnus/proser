/// <reference types="jest" />
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import app from '../index';
import { databaseService } from '../lib/database';
import { hermesAgentCredentials } from '../api/middleware/auth';

const SHARED = 'jest-shared-hermes-secret-0000000000000000';
const ALPHA = 'jest-alpha-agent-secret-00000000000000000';
const BETA = 'jest-beta-agent-secret-000000000000000000';
const OWNER = 'jest-hermes-credential-owner';

function agentToken(identity: string, secret: string, ownerGithubId?: string) {
  return jwt.sign(
    { sub: identity, githubId: identity, username: identity, ...(ownerGithubId ? { ownerGithubId } : {}) },
    secret,
    { algorithm: 'HS256', issuer: 'hermes-agent', audience: 'proser-factory', expiresIn: '5m' },
  );
}
const books = (token: string) => request(app).get('/api/books').set('Authorization', `Bearer ${token}`);

describe('per-agent Hermes credentials', () => {
  const keys = ['HERMES_AGENT_AUTH_SECRET', 'HERMES_AGENT_CREDENTIALS', 'HERMES_AGENT_CREDENTIALS_FILE', 'HERMES_AGENT_ALLOWED_GITHUB_IDS', 'HERMES_AGENT_ALLOWED_OWNER_GITHUB_IDS', 'HERMES_AGENT_GITHUB_ID', 'HERMES_AGENT_ISSUER'];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  beforeEach(() => {
    for (const key of keys) delete process.env[key];
    process.env.HERMES_AGENT_AUTH_SECRET = SHARED;
    process.env.HERMES_AGENT_ALLOWED_GITHUB_IDS = 'service:shared-agent';
    process.env.HERMES_AGENT_CREDENTIALS = JSON.stringify({
      'service:agent-alpha': ALPHA,
      'service:agent-beta': { secret: BETA, owners: [OWNER] },
    });
  });
  afterAll(async () => {
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
    await databaseService.client.user.deleteMany({ where: { githubId: { in: ['service:agent-alpha', 'service:agent-beta', 'service:shared-agent', OWNER] } } });
  });

  it('accepts an agent only under its own secret', async () => {
    expect((await books(agentToken('service:agent-alpha', ALPHA))).status).toBe(200);
    expect((await books(agentToken('service:agent-beta', BETA))).status).toBe(200);
  });

  it('refuses one host impersonating another agent or using the shared secret for a dedicated identity', async () => {
    expect((await books(agentToken('service:agent-beta', ALPHA))).status).toBe(401);
    expect((await books(agentToken('service:agent-alpha', BETA))).status).toBe(401);
    expect((await books(agentToken('service:agent-alpha', SHARED))).status).toBe(401);
    expect((await books(agentToken('service:shared-agent', ALPHA))).status).toBe(401);
  });

  it('keeps the shared secret working for identities without their own credential', async () => {
    expect((await books(agentToken('service:shared-agent', SHARED))).status).toBe(200);
    expect((await books(agentToken('service:unknown-agent', SHARED))).status).toBe(401);
  });

  it('works without any shared secret', async () => {
    delete process.env.HERMES_AGENT_AUTH_SECRET;
    expect((await books(agentToken('service:agent-alpha', ALPHA))).status).toBe(200);
    expect((await books(agentToken('service:shared-agent', SHARED))).status).toBe(401);
  });

  it('scopes owner delegation to the owners listed for that agent', async () => {
    await databaseService.client.user.upsert({ where: { githubId: OWNER }, update: {}, create: { githubId: OWNER, username: 'credential-owner' } });
    process.env.HERMES_AGENT_ALLOWED_OWNER_GITHUB_IDS = OWNER;
    expect((await books(agentToken('service:agent-beta', BETA, OWNER))).status).toBe(200);
    expect((await books(agentToken('service:agent-beta', BETA, 'someone-else'))).status).toBe(401);
    // Alpha has no owner list of its own, so the global list applies.
    expect((await books(agentToken('service:agent-alpha', ALPHA, OWNER))).status).toBe(200);
    delete process.env.HERMES_AGENT_ALLOWED_OWNER_GITHUB_IDS;
    expect((await books(agentToken('service:agent-alpha', ALPHA, OWNER))).status).toBe(401);
    expect((await books(agentToken('service:agent-beta', BETA, OWNER))).status).toBe(200);
  });

  it('rejects malformed, short, and reused secrets instead of falling back', () => {
    expect(() => hermesAgentCredentials({ HERMES_AGENT_CREDENTIALS: 'not json' })).toThrow('JSON object');
    expect(() => hermesAgentCredentials({ HERMES_AGENT_CREDENTIALS: '[]' })).toThrow('JSON object');
    expect(() => hermesAgentCredentials({ HERMES_AGENT_CREDENTIALS: JSON.stringify({ a: 'short' }) })).toThrow('at least 32');
    expect(() => hermesAgentCredentials({ HERMES_AGENT_CREDENTIALS: JSON.stringify({ a: ALPHA, b: ALPHA }) })).toThrow('unique');
    expect(() => hermesAgentCredentials({ HERMES_AGENT_AUTH_SECRET: SHARED, HERMES_AGENT_CREDENTIALS: JSON.stringify({ a: SHARED }) })).toThrow('unique');
    expect(() => hermesAgentCredentials({ HERMES_AGENT_CREDENTIALS: JSON.stringify({ a: { secret: ALPHA, owners: 'x' } }) })).toThrow('owners');
    expect(hermesAgentCredentials({}).size).toBe(0);
  });

  it('reads the credentials file written by the provisioning script', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-credentials-'));
    const file = path.join(directory, 'hermes-agent-credentials.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ 'service:agent-alpha': { owners: [OWNER], secret: ALPHA } }), { mode: 0o600 });
      delete process.env.HERMES_AGENT_CREDENTIALS;
      process.env.HERMES_AGENT_CREDENTIALS_FILE = file;
      await databaseService.client.user.upsert({ where: { githubId: OWNER }, update: {}, create: { githubId: OWNER, username: 'credential-owner' } });
      expect((await books(agentToken('service:agent-alpha', ALPHA, OWNER))).status).toBe(200);
      expect((await books(agentToken('service:agent-alpha', SHARED))).status).toBe(401);
      // A revocation rewrites the file; the next request sees it without a stale cache.
      fs.writeFileSync(file, '{}\n');
      expect((await books(agentToken('service:agent-alpha', ALPHA))).status).toBe(401);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses every request while the credential set is malformed', async () => {
    process.env.HERMES_AGENT_CREDENTIALS = '{broken';
    expect((await books(agentToken('service:shared-agent', SHARED))).status).toBe(500);
  });
});
