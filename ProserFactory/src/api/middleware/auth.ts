import {configuredReleaseCanary} from '@/operations/releaseCanary';
import {releaseRequestKind,admitReleaseMutation,withReleaseAdmission,withReleaseCanaryAdmission} from '@/operations/releaseAdmission';
import { Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { AuthenticatedRequest } from '../types';
import { respondError, ErrorCodes } from '../utils/response';
import logger from '../../lib/logger';
import jwt from 'jsonwebtoken';
import { authenticateServicePrincipal } from './servicePrincipal';
import { databaseService } from '../../lib/database';
import { NovaGrantError } from './novaGrant';
import { withDocumentMutationContext } from '@/services/documentMutationContext';
import { beginSharedResourceMutation, SharedResourceError } from '../../services/sharedResourceService';

/** Constant-time secret comparison to avoid leaking length or content via timing. */
function secretsMatch(supplied: string, expected: string): boolean {
  const suppliedDigest = createHash('sha256').update(supplied).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function backendAuthSecret(): string {
  return process.env.FACTORY_AUTH_SECRET || '';
}

function legacyBackendAuthSecret(): string {
  if (process.env.ALLOW_LEGACY_AUTH_SECRETS !== 'true') return '';
  return process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET || '';
}

function hermesAgentAuthSecret(): string {
  return process.env.HERMES_AGENT_AUTH_SECRET || '';
}

function hermesAgentGithubId(): string {
  return process.env.HERMES_AGENT_GITHUB_ID || 'service:hermes-agent';
}

function hermesAgentGithubIds(): Set<string> {
  const ids = new Set<string>();
  ids.add(hermesAgentGithubId());

  const configured = [
    process.env.HERMES_AGENT_ALLOWED_GITHUB_IDS,
    process.env.HERMES_AGENT_GITHUB_IDS,
  ];

  for (const value of configured) {
    for (const id of String(value || '').split(',')) {
      const trimmed = id.trim();
      if (trimmed) ids.add(trimmed);
    }
  }

  return ids;
}

function hermesAgentIssuer(): string {
  return process.env.HERMES_AGENT_ISSUER || 'hermes-agent';
}

function hermesAgentAudience(): string {
  return process.env.HERMES_AGENT_AUDIENCE || 'proser-factory';
}

// Cache recently resolved token identities to avoid a DB round-trip on every request.
// Entries expire after 5 minutes so deleted users are detected within that window.
const _verifiedUsers = new Map<string, { userId: number; verifiedAt: number }>();
const VERIFY_CACHE_TTL_MS = 5 * 60 * 1000;

interface BackendTokenPayload {
  sub?: string | number;       // user database ID, or a service identity for agent tokens
  githubId?: string;
  username?: string;
  email?: string;
  avatarUrl?: string;
  iss?: string;
  aud?: string | string[];
  iat?: number;
  exp?: number;
  ownerGithubId?: string;
}

function allowedHermesOwnerGithubIds(): Set<string> {
  return new Set(
    String(process.env.HERMES_AGENT_ALLOWED_OWNER_GITHUB_IDS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

let warnedLegacyBackendSecret = false;

interface ResolvedTokenIdentity {
  sub: string;
  jwtUserId: number | null;
  githubId: string;
  username: string;
  email?: string;
  avatarUrl?: string;
}

function normalizeIdentityHandle(value: string | undefined | null): string {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return '';
  const atIndex = raw.indexOf('@');
  return atIndex > 0 ? raw.slice(0, atIndex) : raw;
}

function parseJwtUserId(value: unknown): number | null {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveTokenIdentity(payload: BackendTokenPayload): ResolvedTokenIdentity {
  const sub = String(payload.sub ?? '').trim();
  const jwtUserId = parseJwtUserId(sub);
  const githubId = String(payload.githubId || (jwtUserId === null ? sub : '') || '').trim();
  const username = String(payload.username || githubId || 'Unknown').trim() || 'Unknown';

  return {
    sub,
    jwtUserId,
    githubId,
    username,
    email: payload.email,
    avatarUrl: payload.avatarUrl,
  };
}

function verifiedUserCacheKey(identity: ResolvedTokenIdentity): string | null {
  if (identity.githubId) return `github:${identity.githubId}`;
  if (identity.jwtUserId !== null) return `id:${identity.jwtUserId}`;
  return null;
}

function cacheVerifiedUser(identity: ResolvedTokenIdentity, userId: number, verifiedAt: number): void {
  const cacheKey = verifiedUserCacheKey(identity);
  if (cacheKey) _verifiedUsers.set(cacheKey, { userId, verifiedAt });
}

/** Extract a JWT from the Authorization header. */
function extractToken(req: Request): string | null {
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);
  return null;
}

/**
 * Extract and verify a JWT from the Authorization header.
 * Returns the decoded payload or null if no valid token is present.
 */
function verifyBearerToken(req: Request): BackendTokenPayload | null {
  const token = extractToken(req);
  if (!token) return null;

  const primarySecret = backendAuthSecret();
  const legacySecret = legacyBackendAuthSecret();
  const hermesSecret = hermesAgentAuthSecret();

  if (!primarySecret && !legacySecret && !hermesSecret) {
    logger.error('FACTORY_AUTH_SECRET is not configured — cannot verify tokens');
    return null;
  }

  if (primarySecret) {
    try {
      return jwt.verify(token, primarySecret, {
        algorithms: ['HS256'],
        issuer: 'proser-author',
        audience: 'proser-factory',
      }) as BackendTokenPayload;
    } catch (error) {
      if (!legacySecret && !hermesSecret) throw error;
    }
  }

  if (legacySecret) {
    try {
      const payload = jwt.verify(token, legacySecret, { algorithms: ['HS256'] }) as BackendTokenPayload;
      if (!warnedLegacyBackendSecret) {
        warnedLegacyBackendSecret = true;
        logger.error('SECURITY: accepted a token using opt-in legacy NEXTAUTH_SECRET/AUTH_SECRET; migrate callers to FACTORY_AUTH_SECRET with issuer and audience claims');
      }
      return payload;
    } catch (error) {
      if (!hermesSecret) throw error;
    }
  }

  const payload = jwt.verify(token, hermesSecret, {
    algorithms: ['HS256'],
    issuer: hermesAgentIssuer(),
    audience: hermesAgentAudience(),
  }) as BackendTokenPayload;
  const identity = resolveTokenIdentity(payload);
  const allowedGithubIds = hermesAgentGithubIds();
  if (
    !allowedGithubIds.has(identity.githubId) ||
    identity.sub !== identity.githubId
  ) {
    throw new jwt.JsonWebTokenError('Invalid Hermes agent token identity');
  }
  if (payload.ownerGithubId && !allowedHermesOwnerGithubIds().has(payload.ownerGithubId)) {
    throw new jwt.JsonWebTokenError('Hermes agent owner delegation is not allowed');
  }
  return payload;
}

/**
 * Populate req.user from a verified token payload.
 */
function setUserFromToken(req: AuthenticatedRequest, payload: BackendTokenPayload, userId: number): void {
  const identity = resolveTokenIdentity(payload);
  req.user = {
    id: userId,
    githubId: identity.githubId,
    username: identity.username,
    email: identity.email,
    avatarUrl: identity.avatarUrl,
  };
}

async function setAuthenticatedIdentity(req: AuthenticatedRequest, payload: BackendTokenPayload): Promise<boolean> {
  const actor = resolveTokenIdentity(payload);
  const actorUserId = await ensureUserExists(payload);
  if (actorUserId === null || !Number.isFinite(actorUserId)) return false;

  if (!payload.ownerGithubId) {
    setUserFromToken(req, payload, actorUserId);
    return true;
  }

  const owner = await databaseService.client.user.findUnique({ where: { githubId: payload.ownerGithubId } });
  if (!owner) {
    logger.warn({ actorGithubId: actor.githubId, ownerGithubId: payload.ownerGithubId }, 'Hermes delegated owner does not exist');
    return false;
  }
  req.user = {
    id: owner.id,
    githubId: owner.githubId,
    username: owner.username,
    email: owner.email ?? undefined,
    avatarUrl: owner.avatarUrl ?? undefined,
  };
  req.authActor = { githubId: actor.githubId, username: actor.username };
  return true;
}

/**
 * Ensure the user referenced by the JWT actually exists in the database.
 * After a DB reset the NextAuth session cookie may still carry a valid but
 * stale user ID — this causes FK constraint violations on INSERT.
 *
 * If the user row is missing we upsert by githubId (same as sync-user).
 * The auto-increment ID of the newly created row may differ from the JWT's
 * `sub`, so we return the canonical DB user ID so the caller can patch
 * `req.user.id` accordingly.
 */
async function ensureUserExists(payload: BackendTokenPayload): Promise<number | null> {
  const identity = resolveTokenIdentity(payload);
  const jwtUserId = identity.jwtUserId;
  // If sub is not numeric (e.g. "dev-admin" fallback), resolve by githubId
  const lookupById = jwtUserId !== null;

  const cacheKey = verifiedUserCacheKey(identity);
  const now = Date.now();
  const cached = cacheKey ? _verifiedUsers.get(cacheKey) : null;
  if (cached && now - cached.verifiedAt < VERIFY_CACHE_TTL_MS) return cached.userId;

  try {
    const prisma = databaseService.client;

    // First try by numeric ID (fast path)
    if (lookupById) {
      const existing = await prisma.user.findUnique({ where: { id: jwtUserId } });
      if (existing && (!identity.githubId || existing.githubId === identity.githubId)) {
        cacheVerifiedUser(identity, existing.id, now);
        return existing.id;
      }
    }

    // User not found by ID — upsert by githubId so the row exists for FK refs
    const githubId = identity.githubId;
    if (!githubId) return null;

    const username = identity.username;
    const email = typeof identity.email === 'string' ? identity.email : '';
    const normalizedUsername = normalizeIdentityHandle(username);
    const normalizedEmailHandle = normalizeIdentityHandle(email);

    const existingByGithubId = await prisma.user.findUnique({ where: { githubId } });
    if (existingByGithubId) {
      cacheVerifiedUser(identity, existingByGithubId.id, now);
      return existingByGithubId.id;
    }

    // Compatibility fallback: if the frontend changed how it derives githubId,
    // recover the prior user row by human identity so existing books stay visible.
    let legacyUser = username
      ? await prisma.user.findFirst({ where: { username }, orderBy: { id: 'desc' } })
      : email
        ? await prisma.user.findFirst({ where: { email }, orderBy: { id: 'desc' } })
        : null;

    if (!legacyUser && normalizedUsername && normalizedUsername !== username.toLowerCase()) {
      legacyUser = await prisma.user.findFirst({
        where: { username: normalizedUsername },
        orderBy: { id: 'desc' },
      });
    }

    if (!legacyUser && normalizedEmailHandle && normalizedEmailHandle !== normalizedUsername) {
      legacyUser = await prisma.user.findFirst({
        where: { username: normalizedEmailHandle },
        orderBy: { id: 'desc' },
      });
    }

    if (legacyUser) {
      const updated = await prisma.user.update({
        where: { id: legacyUser.id },
        data: {
          githubId,
          ...(normalizedUsername ? { username: normalizedUsername } : username ? { username } : {}),
          ...(identity.email !== undefined ? { email: identity.email } : {}),
          ...(identity.avatarUrl !== undefined ? { avatarUrl: identity.avatarUrl } : {}),
        },
      });

      logger.warn(
        { legacyUserId: updated.id, githubId, username, previousGithubId: legacyUser.githubId },
        'User identity reconciled from legacy username/email match',
      );

      cacheVerifiedUser(identity, updated.id, now);
      return updated.id;
    }

    const user = await prisma.user.upsert({
      where: { githubId },
      update: {
        username: identity.username,
        ...(identity.email !== undefined && { email: identity.email }),
        ...(identity.avatarUrl !== undefined && { avatarUrl: identity.avatarUrl }),
      },
      create: {
        githubId,
        username: identity.username,
        email: identity.email || null,
        avatarUrl: identity.avatarUrl || null,
      },
    });

    logger.warn(
      { jwtUserId: lookupById ? jwtUserId : identity.sub, dbUserId: user.id, githubId },
      'User resolved/created from JWT (possible DB reset)',
    );

    cacheVerifiedUser(identity, user.id, now);
    return user.id;
  } catch (err) {
    // Let the caller choose whether unresolved identity is fatal.
    logger.error({ err, sub: payload.sub }, 'ensureUserExists check failed');
    return null;
  }
}

/**
 * Unsigned header identities are accepted only by the automated test runner,
 * or by a non-production process whose operator explicitly opted in. An unset
 * or misspelled NODE_ENV must never enable them.
 */
export function legacyHeaderAuthEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (environment.NODE_ENV === 'test') return true;
  return environment.NODE_ENV === 'development' && environment.ALLOW_LEGACY_HEADER_AUTH === 'true';
}

/**
 * Legacy header-based auth for tests and explicitly opted-in local development.
 * Returns true if user was populated, false otherwise.
 */
function tryLegacyHeaderAuth(req: AuthenticatedRequest): boolean {
  if (!legacyHeaderAuthEnabled()) return false;

  const userId = req.headers['x-user-id'] as string;
  const githubId = req.headers['x-github-id'] as string;

  if (!userId || !githubId) return false;

  logger.warn({ userId }, 'Using legacy header-based auth (deprecated — will be removed in production)');
  req.user = {
    id: parseInt(userId, 10),
    githubId,
    username: (req.headers['x-username'] as string) || 'Unknown',
    email: req.headers['x-email'] as string,
    avatarUrl: req.headers['x-avatar-url'] as string,
  };
  return true;
}

// Required authentication middleware
export const authenticateRequest = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const authenticatedNext = () => {
    void (async()=>{
      if (!req.user) { next(); return; }
      const dispatch=()=>withDocumentMutationContext({ userId: req.user!.id, actorGithubId: req.authActor?.githubId, sharedResourceOperationId: req.sharedResourceOperationId, signal: () => req.operationSignal }, () => next());
      if(releaseRequestKind(req.method,req.originalUrl)==='mutation'){
        const canary=await configuredReleaseCanary(req.method,req.originalUrl,req.user.id);
        if(canary){withReleaseCanaryAdmission(canary.admissionId,req.user.id,dispatch);return;}
        const admission=await admitReleaseMutation('http',`${req.method.toUpperCase()} ${req.originalUrl.split('?')[0]}`,{method:req.method,path:req.originalUrl.split('?')[0],body:req.body},req.user.id);
        withReleaseAdmission(admission.id,dispatch);
      }else dispatch();
    })().catch(next);
  };
  try {
    // Preferred path: verify signed JWT from Authorization header
    if (String(req.headers.authorization || '').startsWith('Bearer pnv_')) {
      if (await authenticateServicePrincipal(req)) await beginSharedResourceMutation(req, res, authenticatedNext);
      else respondError(res, ErrorCodes.UNAUTHORIZED, 'Invalid service principal or grant', 401);
      return;
    }
    const payload = verifyBearerToken(req);
    if (payload) {
      if (!(await setAuthenticatedIdentity(req, payload))) {
        logger.warn({ sub: payload.sub, githubId: payload.githubId }, 'Authenticated JWT could not be resolved to a database user');
        respondError(res, ErrorCodes.UNAUTHORIZED, 'Authenticated user could not be resolved', 401);
        return;
      }
      logger.debug({ userId: req.user?.id, actorGithubId: req.authActor?.githubId }, 'User authenticated via JWT');
      authenticatedNext();
      return;
    }

    // Fallback: legacy header-based auth (dev/test only)
    if (tryLegacyHeaderAuth(req)) {
      authenticatedNext();
      return;
    }

    respondError(res, ErrorCodes.UNAUTHORIZED, 'Authentication required', 401);
  } catch (error) {
    if (error instanceof NovaGrantError) {
      respondError(res, ErrorCodes.FORBIDDEN, error.message, 403, { code: error.code });
      return;
    }
    if (error instanceof SharedResourceError) {
      respondError(res, ErrorCodes.CONFLICT, error.message, 409, { code: error.code });
      return;
    }
    const err = error as Error & { name?: string };
    if (err.name === 'TokenExpiredError') {
      respondError(res, ErrorCodes.UNAUTHORIZED, 'Token expired', 401);
      return;
    }
    if (err.name === 'JsonWebTokenError') {
      respondError(res, ErrorCodes.UNAUTHORIZED, 'Invalid token', 401);
      return;
    }
    logger.error({ error }, 'Authentication middleware error');
    respondError(res, ErrorCodes.INTERNAL_ERROR, 'Internal authentication error', 500);
  }
};

// Optional authentication middleware (for public endpoints that can use auth if available)
export const optionalAuth = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const payload = verifyBearerToken(req);
    if (payload) {
      if (await setAuthenticatedIdentity(req, payload)) {
        logger.debug({ userId: req.user?.id }, 'Optional auth — user identified via JWT');
      } else {
        logger.debug({ sub: payload.sub, githubId: payload.githubId }, 'Optional auth — token user could not be resolved');
      }
    } else if (!tryLegacyHeaderAuth(req)) {
      logger.debug('Optional auth — no credentials provided');
    }
    next();
  } catch {
    // Don't fail the request for optional auth — token issues are non-fatal here
    logger.debug('Optional auth — token verification failed, proceeding anonymously');
    next();
  }
};

/**
 * Internal service-to-service authentication middleware.
 * Validates the `X-Internal-Secret` header against `INTERNAL_API_SECRET`.
 * Used for server-side calls from the UI that happen before a user JWT exists
 * (e.g. user upsert during NextAuth sign-in).
 */
export const authenticateInternal = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const expected = process.env.INTERNAL_API_SECRET;
  if (!expected) {
    logger.error('INTERNAL_API_SECRET is not configured — internal endpoint is disabled');
    respondError(res, ErrorCodes.INTERNAL_ERROR, 'Internal endpoint misconfigured', 500);
    return;
  }

  const provided = req.headers['x-internal-secret'] as string | undefined;
  if (!provided || !secretsMatch(provided, expected)) {
    respondError(res, ErrorCodes.UNAUTHORIZED, 'Invalid internal secret', 401);
    return;
  }

  next();
};

// Admin role check middleware (placeholder)
export const requireAdmin = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  if (!req.user) {
    respondError(res, ErrorCodes.UNAUTHORIZED, 'Authentication required', 401);
    return;
  }

  // TODO: Implement admin role checking logic
  // For now, this is a placeholder
  const isAdmin = false; // Check user role in database
  
  if (!isAdmin) {
    respondError(res, ErrorCodes.FORBIDDEN, 'Admin access required', 403);
    return;
  }

  next();
};
