const db = {
  novaResourceClaim: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), upsert: jest.fn() },
  workflowRun: { findUnique: jest.fn() }, imageAsset: { findUnique: jest.fn() }, qualityFinding: { findUnique: jest.fn() },
  sharedResourceOperation: { findUnique: jest.fn() },
};
jest.mock('../../lib/database', () => ({ databaseService: { client: db } }));

import type { AuthenticatedRequest } from '../../api/types';
import { claimNovaResource, novaAction, novaVisibleBookIds, requireNovaResource, type NovaGrant } from '../../api/middleware/novaGrant';
import { sharedResourceOperationView } from '../../services/sharedResourceService';

const grant: NovaGrant = {
  version: 2, originTaskId: 'origin-task-one', ownerActor: 'service:shared-resource:nova', actionClasses: new Set(['create_draft']),
  grantId: 'grant-one', missionId: 'mission-one', missionRevision: 1, taskId: 'task-one',
  requestId: `nova-${'a'.repeat(32)}`, caller: 'senti', issuedAt: 1, expiresAt: 2,
  actions: new Set(['books.read']), resources: new Set(['book:42']),
};
const request = (path: string): AuthenticatedRequest => ({
  originalUrl: path, method: 'GET', body: {}, novaGrant: grant,
} as unknown as AuthenticatedRequest);

beforeEach(() => jest.clearAllMocks());

test('one book read grant covers its export manifest but not another book', async () => {
  const artifactId = 'a'.repeat(64);
  const ownManifest = request(`/api/books/42/export-artifacts/${artifactId}`);
  expect(novaAction('GET', ownManifest.originalUrl, {})).toBe('books.read');
  await expect(requireNovaResource(ownManifest, grant)).resolves.toBeUndefined();

  db.novaResourceClaim.findFirst.mockResolvedValue(null);
  await expect(requireNovaResource(request(`/api/books/43/export-artifacts/${artifactId}`), grant))
    .rejects.toMatchObject({ code: 'DELEGATED_RESOURCE_DENIED' });
});

test('accepts a verified workflow child of the exact granted book', async () => {
  db.workflowRun.findUnique.mockResolvedValue({ bookId: 42 });
  await expect(requireNovaResource(request('/api/workflows/run-one'), grant)).resolves.toBeUndefined();
  db.workflowRun.findUnique.mockResolvedValue({ bookId: 43 });
  db.novaResourceClaim.findFirst.mockResolvedValue(null);
  await expect(requireNovaResource(request('/api/workflows/run-two'), grant)).rejects.toMatchObject({ code: 'DELEGATED_RESOURCE_DENIED' });
});

test('builds a filtered book list from exact and request-owned identities', async () => {
  db.novaResourceClaim.findMany.mockResolvedValue([{ resourceId: '44' }, { resourceId: '42' }]);
  await expect(novaVisibleBookIds(request('/api/books'))).resolves.toEqual([42, 44]);
  expect(db.novaResourceClaim.findMany).toHaveBeenCalledWith(expect.objectContaining({
    where: { requestId: grant.requestId, caller: 'senti', kind: 'book' }, take: 256,
  }));
});

test('persists request ownership and refuses adoption from another request', async () => {
  db.novaResourceClaim.upsert.mockResolvedValue({});
  db.novaResourceClaim.findUnique.mockResolvedValue({ requestId: grant.requestId, caller: 'senti' });
  await expect(claimNovaResource(request('/api/books'), 'book', 45)).resolves.toBeUndefined();
  db.novaResourceClaim.findUnique.mockResolvedValue({ requestId: `nova-${'b'.repeat(32)}`, caller: 'archie' });
  await expect(claimNovaResource(request('/api/books'), 'book', 45)).rejects.toMatchObject({ code: 'DELEGATED_RESOURCE_CONFLICT' });
});

test('publication recovery is bound to the exact workflow route in the signed grant', async () => {
  const workflowId = '5ec31909-9caa-4d94-b6e7-265764101796';
  const publishGrant: NovaGrant = { ...grant, ownerActor: 'service:shared-resource:ardent-nova',
    actionClasses: new Set(['external_publish']),
    actions: new Set(['workflows.publish', 'workflows.read', 'operations.read']),
    resources: new Set([`workflow:${workflowId}`]) };
  const claim = { leaseId: 'lease0123456789abcd', version: 1, resources: [{ resourceKey: 'provider:proser:4', fenceGeneration: '1' }],
    missionRootId: publishGrant.missionId, missionRevision: publishGrant.missionRevision, taskId: publishGrant.originTaskId,
    operationId: 'operation-one', requestSha256: 'a'.repeat(64), actionClass: 'external_publish', deadline: 2_000_000_000,
    caller: { kind: 'delegated', delegationId: publishGrant.taskId }, ownerActor: publishGrant.ownerActor,
    evidenceDomain: 'nova.provider-result.v1' };
  db.sharedResourceOperation.findUnique.mockResolvedValue({ operationId: 'operation-one', claimJson: JSON.stringify(claim),
    state: 'succeeded', method: 'POST', route: `/api/workflows/${workflowId}/finalize`, responseStatus: 202,
    resultJson: '{}', terminalEvidenceJson: null });
  await expect(sharedResourceOperationView('operation-one', publishGrant, 1)).resolves.toMatchObject({
    data: { operationId: 'operation-one', state: 'succeeded', route: `/api/workflows/${workflowId}/finalize` },
  });
  db.sharedResourceOperation.findUnique.mockResolvedValue({ operationId: 'operation-one', claimJson: JSON.stringify(claim),
    state: 'succeeded', method: 'POST', route: '/api/workflows/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/finalize',
    responseStatus: 202, resultJson: '{}', terminalEvidenceJson: null });
  await expect(sharedResourceOperationView('operation-one', publishGrant, 1)).rejects.toMatchObject({ code: 'SHARED_RESOURCE_IDENTITY_MISMATCH' });
});
