# Deployment — Proser Author (V2)

## Quick Deploy (from dev machine)

```bash
bash scripts/deploy-to-proser.sh          # build + rsync + restart
bash scripts/deploy-to-proser.sh --skip-build  # rsync only (already built)
```

This script:

1. Builds the ProserAuthor web shell locally
2. Rsyncs the repo to `proser:/opt/proser-v2/`
3. Installs frozen-lockfile dependencies on `proser`
4. Installs/restarts `proser-v2-web`
5. Removes retired `apps/api` and `apps/worker` artifacts and keeps their units disabled

## Server-Side Auto-Update

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

These are **not** synced by the deploy script (excluded via rsync).

## ProserFactory

ProserAuthor uses ProserFactory for authoring APIs, storage, generation, and image routing.

```bash
# On the server:
FACTORY_URL=http://127.0.0.1:3001
NEXTAUTH_URL=https://proser.example.com
AUTH_URL=https://proser.example.com
FACTORY_AUTH_SECRET=<shared-with-ProserFactory>
FACTORY_AUTH_ISSUER=proser-author
FACTORY_AUTH_AUDIENCE=proser-factory
sudo systemctl disable --now proser-v2-api proser-v2-worker
```

Factory currently serves HTTP on the same host. Keep this URL on loopback;
use a verified HTTPS origin if Factory moves to another host.
