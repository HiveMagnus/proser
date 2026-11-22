// Global Express type augmentation.
//
// The auth middleware attaches the authenticated user (and an optional session)
// to the request. Declaring it here lets handlers read `req.user` directly
// instead of casting `(req as any).user`.
import 'express';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: number;
        githubId: string;
        username: string;
        email?: string;
        avatarUrl?: string;
      };
      authActor?: {
        githubId: string;
        username: string;
      };
      session?: unknown;
      operationSignal?: AbortSignal;
      /** Canonical book ID populated only after an ownership lookup. */
      authorizedBookId?: number;
      /** Unique admission lease owned by this request. */
      operationLeaseId?: string;
    }
  }
}

export {};
