# Environment Variables

Complete reference for the active ProserAuthor web shell.

ProserAuthor no longer runs its own authoring API or worker path. Browser calls stay on relative `/api/*` routes, and the Next.js proxy forwards them to ProserFactory.

---

## Web UI

| Variable                         | Required          | Default                 | Description                                                     |
| -------------------------------- | ----------------- | ----------------------- | --------------------------------------------------------------- |
| `PORT`                           | No                | `3000`                  | Web server listen port                                          |
| `FACTORY_URL`                    | Yes               | `http://127.0.0.1:3001` | ProserFactory base URL used by the Next.js `/api/*` proxy       |
| `NEXTAUTH_URL`                   | No                | `http://localhost:3000` | NextAuth.js canonical URL                                       |
| `NEXTAUTH_SECRET`                | Yes               | -                       | NextAuth.js session encryption secret                           |
| `AUTH_URL`                       | Yes (prod)        | -                       | Companion canonical Auth.js callback origin                     |
| `FACTORY_AUTH_SECRET`            | Yes               | -                       | Dedicated secret for Author-to-Factory JWTs; must match Factory |
| `FACTORY_AUTH_ISSUER`            | No                | `proser-author`         | JWT issuer expected by Factory                                  |
| `FACTORY_AUTH_AUDIENCE`          | No                | `proser-factory`        | JWT audience expected by Factory                                |
| `IAM_CORE_URL`                   | Yes (prod)        | -                       | Magnus IAM login API origin                                     |
| `GITHUB_CLIENT_ID`               | No                | -                       | GitHub OAuth application ID                                     |
| `GITHUB_CLIENT_SECRET`           | No                | -                       | GitHub OAuth application secret                                 |
| `LOCAL_AUTH_ENABLED`             | No                | `false`                 | Explicitly enable local/test credentials                        |
| `LOCAL_AUTH_USERNAME`            | If local auth     | -                       | Local/test-only username                                        |
| `LOCAL_AUTH_PASSWORD`            | If local auth     | -                       | Local/test-only password                                        |
| `LOCAL_AUTH_TRUSTED_PROXY_HOPS`  | No                | `0`                     | Explicit trusted proxy hop count for local-auth source identity |
| `LOCAL_AUTH_TRUSTED_PROXY_PEERS` | With trusted hops | -                       | Comma-separated proxy IP/CIDR allowlist                         |

Local authentication hashes and compares username and password unconditionally,
combines the two results only afterward, and applies the same failure response
plus independent account and trusted-source throttles to unknown usernames and
wrong passwords. The custom Node ingress overwrites its private auth-source
header from the socket peer. Keep `LOCAL_AUTH_TRUSTED_PROXY_HOPS=0` for direct
TLS (the production topology). A positive bounded hop count also requires
`LOCAL_AUTH_TRUSTED_PROXY_PEERS`; forwarding data is used only when the socket
peer matches that IP/CIDR allowlist. Malformed or too-short chains from an
approved peer are rejected with `400`, while forwarding headers from any other
peer are ignored in favor of its socket address. Client-provided
`X-Forwarded-For` and `X-Real-IP` are never consumed directly by local auth.

---

## AI And Images

AI, queueing, storage, and image backend configuration lives in ProserFactory. ProserAuthor only needs `FACTORY_URL`.

Current production topology:

| Service        | Host                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------- |
| Text inference | Qwen3.6 via llama.cpp on `http://127.0.0.1:8000`, configured through ProserFactory        |
| Image backend  | Stable Diffusion WebUI Forge on `http://127.0.0.1:7861`, configured through ProserFactory |

---

## Mobile Runtime Behavior

The phone-first shell does not require extra environment variables, but these defaults affect how it behaves:

| Concern            | Behavior                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| Route space        | Mobile UI lives under `/m`, `/m/studio`, and `/m/read`                                                          |
| Auto-entry         | `apps/web/src/middleware.ts` redirects phone-class user agents into `/m`                                        |
| Desktop override   | `proser-view=desktop` cookie disables auto-entry until changed                                                  |
| Local resume state | `proser-mobile-state` local-storage entry holds last book/scene, draft brief, active trace, and pending command |
| Backend dependency | Mobile generation and revision require a working `FACTORY_URL` target                                           |

---

## TLS

| Variable              | Required | Default | Description                            |
| --------------------- | -------- | ------- | -------------------------------------- |
| `TLS_ENABLED`         | No       | `false` | Enable HTTPS for the web server        |
| `TLS_CERT_FILE`       | If TLS   | -       | Path to TLS certificate file           |
| `TLS_KEY_FILE`        | If TLS   | -       | Path to TLS private key file           |
| `TLS_CA_FILE`         | No       | -       | Path to CA certificate file            |
| `NODE_EXTRA_CA_CERTS` | No       | -       | Additional CA certificates for Node.js |

---

## Example `.env` File

```env
# ProserFactory proxy
FACTORY_URL=http://127.0.0.1:3001

# Web
PORT=3000
NEXTAUTH_URL=http://localhost:3000

# Auth (production - generate with: openssl rand -base64 32)
# NEXTAUTH_SECRET=your-secret-here
# FACTORY_AUTH_SECRET=separate-shared-factory-secret
# FACTORY_AUTH_ISSUER=proser-author
# FACTORY_AUTH_AUDIENCE=proser-factory
# IAM_CORE_URL=https://iam.example.test
# GITHUB_CLIENT_ID=your-github-oauth-id
# GITHUB_CLIENT_SECRET=your-github-oauth-secret
```
