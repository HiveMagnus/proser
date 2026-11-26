# Changelog

Notable changes to Proser. Releases up to v1.0.7 are described on
[GitHub Releases](https://github.com/HiveMagnus/proser/releases). Upgrade steps
are in the [Compose guide](docs/COMPOSE.md#upgrades-and-recovery).

## Unreleased

### Security

- Author refuses `POST`, `PUT`, `PATCH` and `DELETE` requests to `/api/*` whose
  `Origin` is not the Proser origin (`AUTH_URL`, `NEXTAUTH_URL` or the host the
  request was sent to), or whose `Sec-Fetch-Site` reports another site. A page
  on a sibling host under the same parent domain can no longer act with the
  writer's session cookie.
- Author pages send a Content-Security-Policy with a per-request script nonce:
  scripts and connections stay on the Proser origin, and images come only from
  Proser, `data:`/`blob:` URLs and GitHub avatars. Every page now renders per
  request.
- The global API rate limit counts a request against an identity only after the
  token's signature and claims verify. Requests without a valid token, and
  service-principal tokens, count against the client address, so a forged token
  can no longer use up a writer's allowance.
- `GET /api/books/:bookId/creative-package` validates its parameters, checks
  book ownership first and takes the same capacity budget as `/export`
  (2 concurrent per user, 1 per book, 100 a day per user, 30 a day per book).
- Earlier on main (#26, #27): keyless non-loopback inference hosts no longer
  stop Factory, stored cloud API keys are removed and never returned, and
  Oathweave accounts with MFA can sign in.

### Upgrade notes

- If writers open Proser at an address other than `PROSER_ORIGIN`, writes from
  that address are still accepted when the browser's `Origin` matches the
  `Host` the request reached. A reverse proxy that rewrites `Host` must pass
  `X-Forwarded-Host`, or `PROSER_ORIGIN` must name the address writers use.
- Hermes agents that call Factory with a `pnv_` service-principal token now
  share one rate-limit bucket per client address.
