import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { databaseService } from '../../lib/database';
import type { AuthenticatedRequest } from '../types';
import { novaAction, requireNovaResource, resolveNovaGrant, resolveNovaRecoveryGrant } from './novaGrant';

const principalSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().min(1).max(80),
  ownerGithubId: z.string().min(1).max(160),
  scopes: z.array(z.enum(['content:read', 'content:write', 'content:publish', 'grant:register'])),
  callers: z.array(z.enum(['operator', 'senti', 'archie', 'magnus', 'aegis'])),
  expiresAt: z.string().datetime(),
}).strict();

export function resolveServicePrincipal(token: string, method: string, pathname: string, caller: string) {
  if (!/^pnv_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  let raw: unknown;
  try { raw = JSON.parse(process.env.PROSER_SERVICE_PRINCIPALS_JSON || '[]') as unknown; } catch { return null; }
  const configured = z.array(principalSchema).safeParse(raw);
  if (!configured.success) return null;
  const digest = createHash('sha256').update(token).digest();
  const principal = configured.data.find((p) => timingSafeEqual(digest, Buffer.from(p.sha256, 'hex')));
  if (!principal || Date.parse(principal.expiresAt) <= Date.now() || !principal.callers.includes(caller as typeof principal.callers[number])) return null;
  if (method === 'POST' && (pathname === '/api/nova-grants/capabilities-read' || pathname === '/api/nova-grants/books-read'
      || pathname === '/api/nova-grants/generation-read' || pathname === '/api/nova-grants/generation-create'
      || pathname === '/api/nova-grants/workflow-read' || pathname === '/api/nova-grants/workflow-publish'))
    return principal.name === 'nova-creative' && principal.scopes.includes('grant:register') ? principal : null;
  if (!/^\/api\/(?:books|codex|generate|images|workflows|editorial|reviews|findings|models|shared-resource-operations)(?:\/|$)/.test(pathname)) return null;
  const read = ['GET', 'HEAD'].includes(method);
  if (!read && (!['POST', 'PUT', 'PATCH'].includes(method) || /^\/api\/models(?:\/|$)/.test(pathname))) return null;
  const scope = read ? 'content:read' : /\/(?:finalize|decision)$/.test(pathname) ? 'content:publish' : 'content:write';
  return principal.scopes.includes(scope) ? principal : null;
}

export async function authenticateServicePrincipal(req: AuthenticatedRequest): Promise<boolean> {
  const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
  const caller = String(req.headers['x-nova-caller'] || '');
  const requestId = String(req.headers['x-nova-request'] || '');
  if (!/^nova-[a-f0-9]{32}$/.test(requestId)) return false;
  const principal = resolveServicePrincipal(token, req.method, req.originalUrl.split('?')[0] || '', caller);
  if (!principal) return false;
  const owner = await databaseService.client.user.findUnique({ where: { githubId: principal.ownerGithubId } });
  if (!owner) return false;
  req.user = { id: owner.id, githubId: owner.githubId, username: owner.username, email: owner.email ?? undefined };
  req.authActor = { githubId: `service:${principal.name}:${caller}`, username: principal.name };
  const pathname = req.originalUrl.split('?')[0] || '';
  const action = novaAction(req.method, pathname, req.body);
  req.novaGrant = action === 'operations.read'
    ? resolveNovaRecoveryGrant(requestId, caller, action)
    : resolveNovaGrant(requestId, caller, action);
  if (action !== 'operations.read') await requireNovaResource(req, req.novaGrant);
  return true;
}
