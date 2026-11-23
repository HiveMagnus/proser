# Native ProserFactory deployment

Use the [root Compose guide](../../docs/COMPOSE.md) for new installations.
These procedures apply to existing native systemd installations.

## Full native deployment

```bash
bash scripts/deploy-to-proser.sh
```

Run this from `ProserFactory/` for the full native deployment and migration path. It fails on build, install, Prisma migration, systemd, credential, smoke-test, or revision mismatch. It copies only non-secret topology values; `/opt/proser-factory/.env` remains the host-managed secret source. On upgrade it provisions a dedicated random `METRICS_TOKEN` only when the host has none, without printing or replacing an existing credential. The retired webhook listener and cron updater must remain disabled and absent.

For a reviewed Council **code-only** release, the narrower
`scripts/council-code-factory-release.mjs` path stages one digest-pinned `dist`
archive. It requires the installed package, Prisma schema and migrations, and
systemd units to match the candidate, checks that every Prisma migration is
applied with no unresolved row, runs the Redis write/snapshot persistence
preflight before service interruption, and retains a `pg_dump -Fc` archive validated
by `pg_restore --list`. It swaps only `dist` and `REVISION`, probes both
services, database/Redis readiness, and anonymous model access denial. Its
rollback verifies the exact candidate and dump digest, restores the previous
code and revision, and **retains the live PostgreSQL database**. A failed
post-swap probe records the code and database state and attempts the exact
prior-code restore. The protected record directory contains `plan.json`,
`dist.tgz`, and the exact rollback command. Full deployments with migrations
continue through `deploy-to-proser.sh` and require a separate compatibility
and restore decision.

## systemd Services

Copy service files to systemd:

```bash
sudo cp deploy/proser-factory.service /etc/systemd/system/
sudo cp deploy/proser-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now proser-factory proser-worker
```

## TLS / HTTPS

The factory server supports native TLS. Add these to your `.env`:

```dotenv
TLS_ENABLED=true
TLS_CERT_FILE=/opt/proser-factory/certs/server.crt
TLS_KEY_FILE=/opt/proser-factory/certs/server.key
# TLS_CA_FILE=/opt/proser-factory/certs/ca.crt  # if using a custom CA
# NODE_EXTRA_CA_CERTS=/opt/proser-factory/certs/ca.crt

# Update URLs to HTTPS
PUBLIC_BASE_URL=https://your-server:3001
FRONTEND_URL=https://your-server:3000
```

## Hermes Agent Auth

For Hermes Agent deployments, use a dedicated signing secret instead of copying
the UI `NEXTAUTH_SECRET`/`AUTH_SECRET` to the Hermes host:

```dotenv
HERMES_AGENT_AUTH_SECRET=generate-a-dedicated-random-secret
HERMES_AGENT_GITHUB_ID=service:hermes-agent
HERMES_AGENT_ALLOWED_GITHUB_IDS=service:hermes-agent,service:hermes-agent:agent-host
HERMES_AGENT_ISSUER=hermes-agent
```

Tokens signed with `HERMES_AGENT_AUTH_SECRET` are accepted only for that Hermes
service identity. Use `HERMES_AGENT_ALLOWED_GITHUB_IDS` when multiple Hermes
hosts need separate Proser user scopes while sharing the dedicated Hermes
signing secret.

A shared secret lets any host that holds it sign a token for every permitted
agent identity. Give each host its own secret instead:

```dotenv
HERMES_AGENT_CREDENTIALS={"service:hermes-agent:host-a":"<32+ random characters>","service:hermes-agent:host-b":{"secret":"<32+ random characters>","owners":["iam:author"]}}
```

An identity listed in `HERMES_AGENT_CREDENTIALS` is accepted only when its
token is signed with its own secret, never with the shared one, and needs no
entry in `HERMES_AGENT_ALLOWED_GITHUB_IDS`. The optional `owners` list limits
which accounts that agent may act for; without it
`HERMES_AGENT_ALLOWED_OWNER_GITHUB_IDS` applies. Set
`HERMES_AGENT_CREDENTIALS_FILE` to an owner-only JSON file to keep the secrets
out of the environment file. To revoke one host, remove its entry and restart
Factory. Once every host has its own entry, unset `HERMES_AGENT_AUTH_SECRET`.
Factory refuses to start if the value is malformed, a secret is shorter than
32 characters, or two identities share a secret.

## ProserAuthor service auth

Stage the same random `FACTORY_AUTH_SECRET` in ProserAuthor and ProserFactory. ProserAuthor must mint short-lived HS256 tokens with `iss=proser-author` and `aud=proser-factory`. `NEXTAUTH_SECRET`/`AUTH_SECRET` are a temporary logged fallback, not the target configuration.

To provision or rotate a per-host Hermes identity, run:

```bash
scripts/provision-hermes-agent-identity.sh --agent-host agent-host
```

For production, use certificates from a real CA (Let's Encrypt, etc.).
For development/staging, generate self-signed certs:

```bash
bash ../ProserAuthor/scripts/generate-certs.sh /opt/proser-factory/certs
```

After updating `.env`, restart the service:

```bash
sudo systemctl restart proser-factory
```
