# Author deployment Guide

How to deploy the ProserAuthor web shell with the supported rsync path, Docker Compose, or systemd.

---

## Quick Deploy (from dev machine)

The fastest way to deploy to the `proser` server:

```bash
bash scripts/deploy-to-proser.sh          # build + rsync + restart
bash scripts/deploy-to-proser.sh --skip-build  # rsync only (already built)
```

This script:

1. Builds the project locally (`pnpm build`)
2. Rsyncs the repo to `proser:/opt/proser-v2/`
3. Installs dependencies on proser (`pnpm install`)
4. Removes retired `apps/api` and `apps/worker` artifacts from the target
5. Installs the web systemd service and keeps retired Author API/worker units disabled
6. Restarts the web service and fails unless service and readiness checks pass

For sudo-requiring operations, set `SUDO_PASS`/`PROSER_SUDO_PASSWORD` in an accepted local env file or use the script's interactive SSH fallback.

### Server-Side Auto-Update

On the server, pull and rebuild automatically:

```bash
bash deploy/update.sh           # only updates if there are new commits
bash deploy/update.sh --force   # rebuild regardless
```

Set up cron for periodic auto-updates:

```bash
crontab -e
# Add:
*/15 * * * * cd /opt/proser-v2 && bash deploy/update.sh >> deploy/update.log 2>&1
```

See [deploy/README.md](../deploy/README.md) for full deployment reference.

---

## Docker Compose

The Docker Compose file starts the ProserAuthor web shell and points it at ProserFactory through `FACTORY_URL`.

### Quick start

```bash
# Copy and configure environment
cp .env.example .env
# Edit .env with your settings

# Start the web shell
docker compose up -d

# Check health
curl http://localhost:3000/
curl http://localhost:3000/api/readiness
```

### Services

| Service | Port | Description       |
| ------- | ---- | ----------------- |
| `web`   | 3000 | Next.js front-end |

The phone-first mobile shell ships from the same `web` service and route space. No separate deployment target is required, but production smoke checks should cover both `/` and `/m` plus the mobile revision endpoint on the backend.

### Volumes

- ProserAuthor container mode runs only the web shell. ProserFactory owns API storage, queueing, model routing, and image backend dependencies.

---

## Systemd (bare metal)

Service files are in `deploy/`. The deploy script installs them automatically, or manually:

```bash
# Copy service files
sudo cp deploy/proser-v2-web.service /etc/systemd/system/

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable --now proser-v2-web

# Check status
sudo systemctl status proser-v2-web
```

### Environment files (on server)

Create these in `/opt/proser-v2/`:

- `.env.web` — Web: `PORT`, `TLS_*`, `NEXTAUTH_*`, `FACTORY_URL`

The deploy script requires `.env.web` to exist, assigns it to the web service
user, and enforces mode `0600` before dependency installation or restart.
Retired `.env.api` and `.env.worker` files are removed with the retired units.

### ProserFactory

ProserAuthor uses ProserFactory for authoring APIs, storage, generation, and image routing.

```env
FACTORY_URL=http://127.0.0.1:3001
```

`proser-v2-api` and `proser-v2-worker` are retired ProserAuthor units. Keep them disabled:

```bash
sudo systemctl disable --now proser-v2-api proser-v2-worker
```

---

## Health Checks

The web container includes a health check:

| Service | Endpoint                                       | Interval |
| ------- | ---------------------------------------------- | -------- |
| Web     | `GET /` (successful response or auth redirect) | 15s      |

The restart policy restarts exited containers. Use the healthcheck to detect an unhealthy running container.

Recommended post-deploy smoke checks for the mobile rollout:

- `GET /` for the desktop shell
- `GET /m` for the phone shell
- `GET /api/readiness` through the web proxy
- `GET /api/images/health` through the web proxy, confirming Forge routing from ProserFactory

---

## First-run setup

Use the setup script for a guided first-run experience:

```bash
./scripts/setup.sh
```

This script:

1. Checks prerequisites (Node.js, pnpm, Docker)
2. Copies `.env.example` to `.env` if missing
3. Installs workspace dependencies
4. Builds the active web workspace

---

## Combined installation

Use the [root Compose configuration](../../docs/COMPOSE.md) to start Author,
Factory, the worker, PostgreSQL, and Redis together. The stand-alone Author
examples on this page expect a separately configured Factory service.

## Production checklist

- [ ] Set `NODE_ENV=production`
- [ ] Generate a strong `NEXTAUTH_SECRET` (`openssl rand -base64 32`)
- [ ] Configure Magnus IAM or GitHub OAuth (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`)
- [ ] Set a dedicated `FACTORY_AUTH_SECRET` matching ProserFactory
- [ ] Configure TLS termination (reverse proxy or `TLS_ENABLED=true`)
- [ ] Set up log rotation for application logs
- [ ] Monitor health endpoints
