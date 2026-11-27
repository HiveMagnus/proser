import { NextResponse, type NextRequest } from 'next/server';

import { handlers, passwordRelayRetired } from '@/auth';

// The `iam` callback carried Oathweave passwords to Oathweave's login API until
// the relay was removed. Local password sign-in still uses this callback, so it
// is answered here only on Oathweave installations.
const RETIRED_RELAY_CALLBACK = '/api/auth/callback/iam';

function passwordRelayRemoved() {
  return NextResponse.json(
    {
      ok: false,
      success: false,
      error: {
        code: 'PASSWORD_RELAY_REMOVED',
        message:
          'Proser no longer accepts Oathweave passwords. Sign in with Oathweave from the sign-in page.',
        signInUrl: '/auth/signin',
      },
    },
    { status: 410, headers: { 'Cache-Control': 'no-store' } },
  );
}

function retiredRelay(request: NextRequest) {
  return passwordRelayRetired && request.nextUrl.pathname === RETIRED_RELAY_CALLBACK;
}

export async function GET(request: NextRequest) {
  return retiredRelay(request) ? passwordRelayRemoved() : handlers.GET(request);
}

export async function POST(request: NextRequest) {
  return retiredRelay(request) ? passwordRelayRemoved() : handlers.POST(request);
}
