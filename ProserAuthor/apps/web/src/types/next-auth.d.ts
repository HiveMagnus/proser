import type { DefaultSession } from 'next-auth';

// Module augmentation for the extra fields the IAM and GitHub providers stash
// on the auth `User` and expose on the client-facing `Session`. Keeping these
// typed lets the auth callbacks avoid `any` casts.
//
// Note: the JWT is intentionally not augmented here. `@auth/core`'s `JWT`
// already extends `Record<string, unknown>`, and augmenting the re-exported
// `next-auth/jwt` module is unreliable, so the session callback narrows token
// fields with explicit type guards instead.
declare module 'next-auth' {
  interface User {
    iamAccessToken?: string;
    iamRefreshToken?: string | null;
    iamUsername?: string;
    iamRoles?: string[];
    login?: string;
  }

  interface Session {
    user: {
      id: string;
      username?: string;
      roles?: string[];
      provider?: string;
      /** Seconds since the epoch at which this session was signed in. */
      sessionIssuedAt?: number;
    } & DefaultSession['user'];
  }
}
