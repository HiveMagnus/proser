# Environment Variables

Configure the web shell in `apps/web/.env.local` for source development or
in `.env.web` for the native systemd service. For the combined Compose stack,
configure the variables that `compose.yml` forwards from `.env.compose`.
Compose sets `AUTH_URL` from `PROSER_ORIGIN` and `FACTORY_URL` to
`http://factory:3001`. The initializer generates the local login and both
application secrets. See [Compose configuration](../../docs/COMPOSE.md).

---

## Web UI

| Variable                         | Required            | Default          | Description                                                     |
| -------------------------------- | ------------------- | ---------------- | --------------------------------------------------------------- |
| `PORT`                           | No                  | `3000`           | Custom Node server listen port                                  |
| `FACTORY_URL`                    | Yes                 | —                | ProserFactory base URL used by the Next.js `/api/*` proxy       |
| `NEXTAUTH_URL`                   | No                  | —                | Compatibility setting for the Auth.js browser origin            |
| `NEXTAUTH_SECRET`                | Yes                 | -                | NextAuth.js session encryption secret                           |
| `AUTH_SESSION_MAX_LIFETIME_DAYS` | No                  | `90`             | Days after sign-in at which a session ends even if still in use |
| `AUTH_URL`                       | See below           | —                | Canonical Auth.js browser origin                                |
| `FACTORY_AUTH_SECRET`            | Yes                 | -                | Dedicated secret for Author-to-Factory JWTs; must match Factory |
| `FACTORY_AUTH_ISSUER`            | No                  | `proser-author`  | JWT issuer expected by Factory                                  |
| `FACTORY_AUTH_AUDIENCE`          | No                  | `proser-factory` | JWT audience expected by Factory                                |
| `IAM_CORE_URL`                   | If using Oathweave  | —                | Marks an Oathweave installation; turns local sign-in off        |
| `OATHWEAVE_OIDC_ISSUER`          | For Oathweave OIDC  | —                | Exact `iss` of Oathweave's ID tokens                            |
| `OATHWEAVE_OIDC_CLIENT_ID`       | For Oathweave OIDC  | —                | Client ID registered in Oathweave                               |
| `OATHWEAVE_OIDC_CLIENT_SECRET`   | Confidential client | —                | Client secret; unset for a public client                        |
| `OATHWEAVE_OIDC_*` endpoints     | No                  | discovery        | Discovery URL or explicit endpoints; see the OIDC guide         |
| `GITHUB_CLIENT_ID`               | No                  | -                | GitHub OAuth application ID                                     |
| `GITHUB_CLIENT_SECRET`           | No                  | -                | GitHub OAuth application secret                                 |
| `GITHUB_ALLOWED_IDS`             | If using GitHub     | -                | Comma-separated numeric GitHub account IDs allowed to sign in   |
| `LOCAL_AUTH_ENABLED`             | No                  | `false`          | Explicitly enable local/test credentials                        |
| `LOCAL_AUTH_USERNAME`            | If local auth       | -                | Username for local credentials                                  |
| `LOCAL_AUTH_PASSWORD`            | If local auth       | -                | Password for local credentials                                  |
| `LOCAL_AUTH_TRUSTED_PROXY_HOPS`  | No                  | `0`              | Explicit trusted proxy hop count for local-auth source identity |
| `LOCAL_AUTH_TRUSTED_PROXY_PEERS` | With trusted hops   | -                | Comma-separated proxy IP/CIDR allowlist                         |

Set `AUTH_URL` to the exact scheme, hostname, and optional port users open.
When `NEXTAUTH_URL` is also set, give it the same value. The native deployment
scripts expect a canonical HTTPS origin on port 443. `IAM_CORE_URL` marks an
Oathweave installation, which offers no local password sign-in. Without it,
local credentials are available when explicitly enabled.
`OATHWEAVE_OIDC_ISSUER` and `OATHWEAVE_OIDC_CLIENT_ID` add **Sign in with
Oathweave** (OpenID Connect, authorization code with S256 PKCE), so passwords
are entered at Oathweave instead of in Proser. The first OIDC sign-in links the
writer's existing account by Oathweave username, and later sign-ins use the
Oathweave `sub`. Proser never takes an Oathweave password: the former password
relay was removed, and `OATHWEAVE_PASSWORD_RELAY` has no effect. With
`IAM_CORE_URL` set, its former callback `/api/auth/callback/iam` answers
`410 Gone` (`PASSWORD_RELAY_REMOVED`) without reading the request. With
`IAM_CORE_URL` set and OIDC not configured, Oathweave writers cannot sign in,
and Author logs why at startup. Client registration and every OIDC setting are
described in the [Oathweave OIDC guide](../../docs/OATHWEAVE_OIDC.md).
Two-step verification and passkeys are handled on Oathweave's sign-in page.

Local authentication hashes and compares username and password unconditionally,
combines the two results only afterward, and applies the same failure response
plus independent account and trusted-source throttles to unknown usernames and
wrong passwords. The custom Node ingress overwrites its private auth-source
header from the socket peer. Keep `LOCAL_AUTH_TRUSTED_PROXY_HOPS=0` for direct
TLS or the default loopback Compose deployment. A positive bounded hop count also requires
`LOCAL_AUTH_TRUSTED_PROXY_PEERS`; forwarding data is used only when the socket
peer matches that IP/CIDR allowlist. Malformed or too-short chains from an
approved peer are rejected with `400`, while forwarding headers from any other
peer are ignored in favor of its socket address. Client-provided
`X-Forwarded-For` and `X-Real-IP` are never consumed directly by local auth.

---

## AI and images

Configure text and image providers in Factory. See
[optional providers](../../docs/COMPOSE.md#optional-providers) for Compose
and [Factory environment variables](../../ProserFactory/README.md#environment-variables)
for native configuration.

## Mobile Runtime Behavior

The phone-first shell does not require extra environment variables, but these defaults affect how it behaves:

| Concern            | Behavior                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------- |
| Route space        | Mobile UI lives under `/m`, `/m/studio`, and `/m/read`                                      |
| Auto-entry         | `apps/web/src/proxy.ts` redirects phone-class user agents into `/m`                         |
| Desktop override   | `proser-view=desktop` cookie disables auto-entry until changed                              |
| Local resume state | User-scoped `proser-mobile-state-v1` local storage holds book, scene, and shell preferences |
| Backend dependency | Mobile generation and revision require a working `FACTORY_URL` target                       |

---

## TLS

These settings apply to the custom native Author server. Use the host HTTPS
proxy and `PROSER_ORIGIN` for the released Compose stack.

| Variable              | Required | Default | Description                            |
| --------------------- | -------- | ------- | -------------------------------------- |
| `TLS_ENABLED`         | No       | `false` | Enable HTTPS for the web server        |
| `TLS_CERT_FILE`       | If TLS   | -       | Path to TLS certificate file           |
| `TLS_KEY_FILE`        | If TLS   | -       | Path to TLS private key file           |
| `TLS_CA_FILE`         | No       | -       | Path to CA certificate file            |
| `NODE_EXTRA_CA_CERTS` | No       | -       | Additional CA certificates for Node.js |

---

## Development example

Start from [the development setup](DEVELOPMENT.md#set-up-the-web-workspace).
The template is [`ProserAuthor/.env.example`](../.env.example). Put the
configured copy under `apps/web/.env.local` and keep it owner-only.
