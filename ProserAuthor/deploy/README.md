# Native ProserAuthor deployment

Use the [root Compose guide](../../docs/COMPOSE.md) for new installations.
This runbook applies to existing native systems running `proser-v2-web`.
Run the workstation commands from `ProserAuthor/` after configuring the
`proser` SSH alias for the intended native host.

## Quick Deploy (from dev machine)

```bash
bash scripts/deploy-to-proser.sh --dry-run
bash scripts/deploy-to-proser.sh
```

This script:

1. Builds the ProserAuthor web shell locally
2. Takes a checksummed checkpoint and rsyncs the release to `proser:/opt/proser-v2/`
3. Installs frozen-lockfile dependencies on the configured host
4. Removes retired `apps/api` and `apps/worker` artifacts and keeps their units disabled
5. Restarts `proser-v2-web` and verifies the installed revision and HTTPS readiness

The dry run builds locally and checks the installed service and revision.
An activation can use `--release-id ID` to name its checkpoint. Use
`--rollback ID` to restore that release's compatible prior code from its
checkpoint. For privileged commands, the script uses noninteractive SSH sudo
or the credential from a protected component environment file.

## Server-Side Auto-Update

Use the reviewed workstation deployment above for this repository. The
server-side updater below applies to an existing standalone Author Git
checkout with a compatible Factory deployment and the pinned runtime.

```bash
# On the server — pull latest and rebuild:
bash deploy/update.sh           # only updates if there are new commits
bash deploy/update.sh --force   # rebuild regardless
```

### Cron (fallback, every 15 minutes)

```bash
crontab -e
# Add:
*/15 * * * * cd /opt/proser-v2 && bash deploy/update.sh >> deploy/update.log 2>&1
```

### Logs

```bash
tail -f /opt/proser-v2/deploy/update.log
```

The native scripts read the canonical HTTPS origin from the protected host
environment. A first installation can supply `PROSER_AUTHOR_SERVICE_USER`.
Subsequent deployments preserve the configured non-root user. For certificate
renewal, place `PROSER_TLS_DOMAIN` in the private user service environment file
at `~/.config/proser/tls.env` and scope the restart rule to that host account.

## systemd Services

```bash
# Install service files
sudo cp deploy/proser-v2-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now proser-v2-web
```

| Service         | Port | Description                      |
| --------------- | ---- | -------------------------------- |
| `proser-v2-web` | 443  | Next.js frontend with native TLS |

## Environment Files

On the server, create/edit these files in `/opt/proser-v2/`:

- `.env.web` — Web config (PORT, TLS, NEXTAUTH, FACTORY_URL, FACTORY_AUTH_SECRET)

Provision `.env.web` on the host. The deploy script preserves it and applies the
service account ownership and mode `0600`.

## ProserFactory

ProserAuthor uses ProserFactory for authoring APIs, storage, generation, and image routing.

```dotenv
FACTORY_URL=http://127.0.0.1:3001
NEXTAUTH_URL=https://proser.example.com
AUTH_URL=https://proser.example.com
FACTORY_AUTH_SECRET=<shared-with-ProserFactory>
FACTORY_AUTH_ISSUER=proser-author
FACTORY_AUTH_AUDIENCE=proser-factory
```

Keep the Factory URL on loopback for a same-host deployment and use a verified
HTTPS origin for a separate host.
