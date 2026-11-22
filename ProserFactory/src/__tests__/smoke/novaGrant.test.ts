import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
jest.mock('../../lib/database', () => ({ databaseService: { client: {} } }));
import { novaAction, resolveNovaGrant } from '../../api/middleware/novaGrant';

const requestId = `nova-${'a'.repeat(32)}`;
const keys = generateKeyPairSync('ed25519');
const publicPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const keyId = createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function record(overrides: Record<string, unknown> = {}) {
  const unsigned = {
    version: 2,
    grant_id: 'mission-one-r1-proser', mission_id: 'mission-one', mission_revision: 1,
    origin_task_id: 'origin-task-one', task_id: 'task-one', request_id: requestId, caller: 'senti', audience: 'proser', owner_actor: 'service:shared-resource:nova',
    action_classes: ['observe', 'create_draft'],
    issued_at: 1_700_000_000, expires_at: 1_800_000_000,
    actions: ['books.read'], resources: ['book:42'], revoked: false, key_id: keyId,
    ...overrides,
  };
  return { ...unsigned, signature: sign(null, Buffer.from(canonical(unsigned)), keys.privateKey).toString('base64url') };
}

function configure(value = record()) {
  process.env.PROSER_NOVA_GRANT_PUBLIC_KEY_PEM = publicPem;
  process.env.PROSER_NOVA_GRANTS_JSON = JSON.stringify({ [requestId]: value });
}

afterEach(() => {
  delete process.env.PROSER_NOVA_GRANT_PUBLIC_KEY_PEM;
  delete process.env.PROSER_NOVA_GRANTS_JSON;
});

test('accepts an exact signed mission, caller, request, action and resource grant', () => {
  configure();
  expect(resolveNovaGrant(requestId, 'senti', 'books.read', 1_750_000_000)).toMatchObject({
    missionId: 'mission-one', missionRevision: 1, originTaskId: 'origin-task-one', taskId: 'task-one', requestId, caller: 'senti',
  });
});

test('accepts a signed read-only grant with no shared-resource action class', () => {
  configure(record({ action_classes: [] }));
  expect(resolveNovaGrant(requestId, 'senti', 'books.read', 1_750_000_000).actionClasses.size).toBe(0);
});

test('requires a shared-resource action class for a signed mutation grant', () => {
  configure(record({ action_classes: [], actions: ['books.read', 'books.write'] }));
  expect(() => resolveNovaGrant(requestId, 'senti', 'books.read', 1_750_000_000)).toThrow(expect.objectContaining({ code: 'INVALID_DELEGATION_CONFIG' }));
});

test('rejects an unsigned change to the action classes', () => {
  configure({ ...record(), action_classes: [] });
  expect(() => resolveNovaGrant(requestId, 'senti', 'books.read', 1_750_000_000)).toThrow(expect.objectContaining({ code: 'INVALID_DELEGATION_SIGNATURE' }));
});

test.each([
  [{ caller: 'archie' }, 'DELEGATION_PRINCIPAL_MISMATCH'],
  [{ audience: 'modulatron' }, 'INVALID_DELEGATION_CONFIG'],
  [{ expires_at: 1_700_000_001 }, 'DELEGATION_EXPIRED'],
  [{ revoked: true }, 'DELEGATION_REVOKED'],
])('rejects wrong-principal, audience, expiry and revocation', (overrides, code) => {
  configure(record(overrides));
  expect(() => resolveNovaGrant(requestId, 'senti', 'books.read', 1_750_000_000)).toThrow(expect.objectContaining({ code }));
});

test('rejects a modified signed field and an ungranted action', () => {
  const value = record();
  configure({ ...value, resources: ['book:43'] });
  expect(() => resolveNovaGrant(requestId, 'senti', 'books.read', 1_750_000_000)).toThrow(expect.objectContaining({ code: 'INVALID_DELEGATION_SIGNATURE' }));
  configure(value);
  expect(() => resolveNovaGrant(requestId, 'senti', 'books.create', 1_750_000_000)).toThrow(expect.objectContaining({ code: 'DELEGATED_ACTION_DENIED' }));
});

test('keeps readiness/capabilities separate from generation authority', () => {
  expect(novaAction('GET', '/api/models/status', undefined)).toBe('capabilities.read');
  expect(novaAction('GET', '/api/images/health', undefined)).toBe('capabilities.read');
  expect(novaAction('POST', '/api/generate/prose', { bookId: 42 })).toBe('generation.create');
  expect(novaAction('POST', '/api/books', {})).toBe('books.create');
});

test('rejects a group-writable verification key file', () => {
  const directory = mkdtempSync(join(tmpdir(), 'proser-nova-key-')); const filename = join(directory, 'issuer.pub.pem');
  writeFileSync(filename, publicPem, { mode: 0o666 }); chmodSync(filename, 0o666);
  delete process.env.PROSER_NOVA_GRANT_PUBLIC_KEY_PEM; process.env.PROSER_NOVA_GRANT_PUBLIC_KEY_FILE = filename;
  process.env.PROSER_NOVA_GRANTS_JSON = JSON.stringify({ [requestId]: record() });
  try { expect(() => resolveNovaGrant(requestId, 'senti', 'books.read', 1_750_000_000)).toThrow(expect.objectContaining({ code: 'INVALID_DELEGATION_CONFIG' })); }
  finally { delete process.env.PROSER_NOVA_GRANT_PUBLIC_KEY_FILE; rmSync(directory, { recursive: true, force: true }); }
});
