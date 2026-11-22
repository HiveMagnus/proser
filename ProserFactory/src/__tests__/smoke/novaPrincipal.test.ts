import { createHash } from 'node:crypto';
jest.mock('../../lib/database', () => ({ databaseService: { client: {} } }));
import { resolveServicePrincipal } from '../../api/middleware/servicePrincipal';
const token = 'pnv_' + 'a'.repeat(43);
afterEach(() => { delete process.env.PROSER_SERVICE_PRINCIPALS_JSON; });
test('Nova uses a separate credential and caller on the shared library, without administrative access', () => {
  process.env.PROSER_SERVICE_PRINCIPALS_JSON = JSON.stringify([{ sha256:createHash('sha256').update(token).digest('hex'),name:'nova',ownerGithubId:'shared-owner',scopes:['content:read','content:write'],callers:['senti','archie'],expiresAt:'2099-01-01T00:00:00.000Z' }]);
  expect(resolveServicePrincipal(token,'POST','/api/images/import','senti')?.ownerGithubId).toBe('shared-owner');
  expect(resolveServicePrincipal(token,'GET','/api/codex/1','archie')).not.toBeNull();
  expect(resolveServicePrincipal(token,'POST','/api/workflows/run/finalize','senti')).toBeNull();
  expect(resolveServicePrincipal(token,'DELETE','/api/books/1','senti')).toBeNull();
  expect(resolveServicePrincipal(token,'GET','/api/settings','senti')).toBeNull();
  expect(resolveServicePrincipal(token,'GET','/api/books','stranger')).toBeNull();
});
test('invalid and malformed credentials fail closed', () => {
  process.env.PROSER_SERVICE_PRINCIPALS_JSON = 'invalid';
  expect(resolveServicePrincipal(token,'GET','/api/books','senti')).toBeNull();
  expect(resolveServicePrincipal('forged','GET','/api/books','senti')).toBeNull();
});
test('workflow publication needs both the registered grant and content:publish principal scope', () => {
  const pathname = '/api/workflows/5ec31909-9caa-4d94-b6e7-265764101796/finalize';
  const principal = { sha256:createHash('sha256').update(token).digest('hex'), name:'nova-creative',
    ownerGithubId:'shared-owner',scopes:['content:read','content:write','grant:register'],
    callers:['senti'],expiresAt:'2099-01-01T00:00:00.000Z' };
  process.env.PROSER_SERVICE_PRINCIPALS_JSON = JSON.stringify([principal]);
  expect(resolveServicePrincipal(token,'POST','/api/nova-grants/workflow-publish','senti')).not.toBeNull();
  expect(resolveServicePrincipal(token,'POST',pathname,'senti')).toBeNull();
  process.env.PROSER_SERVICE_PRINCIPALS_JSON = JSON.stringify([{ ...principal, scopes: [...principal.scopes, 'content:publish'] }]);
  expect(resolveServicePrincipal(token,'POST',pathname,'senti')).not.toBeNull();
});
