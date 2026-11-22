const mockDatabase = { qualityFinding: { findUnique: jest.fn() } };
jest.mock('../../lib/database', () => ({ databaseService: { client: mockDatabase } }));
import type { AuthenticatedRequest } from '../../api/types';
import type { NovaGrant } from '../../api/middleware/novaGrant';
import { parseSharedResourceClaim, resolveSharedResourceProviderKey, sharedResourceCanonicalJson } from '../../services/sharedResourceService';
import { createHash } from 'node:crypto';

const grant: NovaGrant = {
  version: 2, grantId: 'grant-one', missionId: 'mission-one', missionRevision: 3,
  originTaskId: 'origin-task-one', taskId: 'delegated-task-one', requestId: `nova-${'a'.repeat(32)}`,
  caller: 'senti', ownerActor: 'service:shared-resource:nova', actionClasses: new Set(['create_draft']),
  issuedAt: 1, expiresAt: 4_000_000_000, actions: new Set(['books.create']), resources: new Set(['new']),
};

function request(overrides: Record<string, string> = {}) {
  const claim = { leaseId: 'lease_abcdefghijklmnop', version: 1,
    resources: [{ resourceKey: 'gpu:inference-host', fenceGeneration: '8' }, { resourceKey: 'provider:new:proser', fenceGeneration: '12' }],
    missionRootId: grant.missionId, missionRevision: grant.missionRevision, taskId: grant.originTaskId,
    operationId: 'operation-proser-one', requestSha256: 'b'.repeat(64), actionClass: 'create_draft',
    deadline: Math.floor(Date.now() / 1000) + 300, caller: { kind: 'delegated', delegationId: grant.taskId },
    ownerActor: grant.ownerActor, evidenceDomain: 'nova.provider-result.v1' };
  const json = sharedResourceCanonicalJson(claim); const encoded = Buffer.from(json).toString('base64url');
  return { headers: { 'x-magnus-fence-set': encoded, 'x-magnus-fence-set-sha256': createHash('sha256').update(json).digest('hex'),
    'x-magnus-lease-id': claim.leaseId, 'x-magnus-operation-id': claim.operationId,
    'x-magnus-request-sha256': claim.requestSha256, 'x-magnus-evidence-domain': claim.evidenceDomain,
    'x-magnus-resource-key': 'provider:new:proser', 'x-magnus-fence-generation': '12', ...overrides } } as unknown as AuthenticatedRequest;
}

test('accepts an exact canonical ordered multi-resource claim bound to the v2 grant', () => {
  expect(parseSharedResourceClaim(request(), grant)).toMatchObject({ operationId: 'operation-proser-one', selectedResourceKey: 'provider:new:proser' });
});

test.each([
  [{ 'x-magnus-operation-id': 'different-operation' }, 'INVALID_SHARED_RESOURCE_CLAIM'],
  [{ 'x-magnus-fence-generation': '11' }, 'INVALID_SHARED_RESOURCE_CLAIM'],
])('rejects inconsistent singular headers', (headers, code) => {
  expect(() => parseSharedResourceClaim(request(headers), grant)).toThrow(expect.objectContaining({ code }));
});

test('rejects task and action-class drift from the signed grant', () => {
  expect(() => parseSharedResourceClaim(request(), { ...grant, originTaskId: 'other-origin' })).toThrow(expect.objectContaining({ code: 'SHARED_RESOURCE_IDENTITY_MISMATCH' }));
  expect(() => parseSharedResourceClaim(request(), { ...grant, actionClasses: new Set(['observe']) })).toThrow(expect.objectContaining({ code: 'SHARED_RESOURCE_IDENTITY_MISMATCH' }));
});

test('uses the authoritative finding owner and rejects unbound non-book mutations', async () => {
  mockDatabase.qualityFinding.findUnique.mockResolvedValue({ reviewRun: { bookId: 43 } });
  await expect(resolveSharedResourceProviderKey({ originalUrl: '/api/findings/finding-one', method: 'PATCH', body: { bookId: 42 } } as AuthenticatedRequest))
    .resolves.toBe('provider:proser:43');
  await expect(resolveSharedResourceProviderKey({ originalUrl: '/api/generate/title', method: 'POST', body: {} } as AuthenticatedRequest))
    .rejects.toMatchObject({ code: 'SHARED_RESOURCE_IDENTITY_MISMATCH' });
  await expect(resolveSharedResourceProviderKey({ originalUrl: '/api/workflows/full-book', method: 'POST', body: {} } as AuthenticatedRequest))
    .resolves.toBe('provider:new:proser');
  await expect(resolveSharedResourceProviderKey({ originalUrl: '/api/editorial/benchmarks', method: 'POST', body: { maximumCases: 1 } } as AuthenticatedRequest))
    .resolves.toBe('provider:new:proser');
});
