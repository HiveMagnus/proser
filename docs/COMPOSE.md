# Run Proser with Docker Compose

Compose runs Author, Factory and its worker from one application image.
PostgreSQL and Redis use their own persistent volumes on an internal network.
The application image includes the pinned document renderer and publication
fonts. Configure text and image models separately if you need generation.

## First run

Use the [prebuilt-image quick start](../README.md#quick-start) for the released
`linux/amd64` image. Use the checkout matching the image's GitHub release tag.

Releases after v1.0.7 can also generate `.env.compose` from the image, so a
prebuilt install needs only Docker and the release's `compose.yml` and
`compose.factory-api.yml` (from a checkout or downloaded from the release tag):

```bash
(umask 077; docker run --rm ghcr.io/hivemagnus/proser:<version> node scripts/init-compose-env.mjs - > .env.compose)
```

Open `http://localhost:3000` and sign in with `LOCAL_AUTH_USERNAME` and
`LOCAL_AUTH_PASSWORD` from the owner-only `.env.compose` file. Keep that file
with the deployment and its backups. The initialization script creates distinct
random credentials and refuses to overwrite an existing file. The generated
file enables local Author credentials and publishes Author and Factory on
loopback only.

For a prebuilt release, set `PROSER_IMAGE` in `.env.compose` to the image tag or
digest listed in the [release notes](https://github.com/HiveMagnus/proser/releases).
Pull that reference with `docker pull`, then start Compose with `--no-build`.
Author, Factory, the worker and the database initializer all use the same image.
The public registry image supports anonymous pulls. Pull it explicitly so the
Factory, worker, and initializer can start from the same local image reference.

### Build from source

From the repository root with Node `24.22.3` and Docker Compose installed:

```bash
node scripts/init-compose-env.mjs
docker compose --env-file .env.compose -f compose.yml -f compose.factory-api.yml up -d --build --wait
```

The initializer records the checked-out Git SHA in `PROSER_REVISION`. If you
reuse a source-build environment after changing commits, update that value to
the new full SHA. Use a separate source-build environment for an installation
that currently points `PROSER_IMAGE` at a registry release.

The initializer installs or verifies the reviewed document-enforcement SQL.
Automatic activation runs only against a fresh Compose-managed database. On
subsequent starts it checks the saved activation evidence and migration status.
Review pending migrations before starting an upgraded stack. See
[upgrades and recovery](#upgrades-and-recovery).

## Direct Factory API access

The Factory override opens `http://127.0.0.1:3001` for local API clients and
agents. The generated environment selects both Compose files by default on
Unix-like hosts. The examples use `-f` to select files explicitly.
Select only `compose.yml` to keep Factory inside the Compose network:

```bash
docker compose --env-file .env.compose -f compose.yml up -d --no-build --wait
```

Add the override again to publish it. Change `PROSER_FACTORY_BIND` and
`PROSER_FACTORY_PORT` to select a different host socket. Keep the bind on
loopback for a local HTTPS reverse proxy. An agent on another host should use
an authenticated TLS endpoint and its own scoped Factory credential. The
[Factory API](../PROSER_API.md) describes authentication and endpoints. Give
each Hermes host its own signing secret in `HERMES_AGENT_CREDENTIALS` rather
than sharing `HERMES_AGENT_AUTH_SECRET`. From a checkout with SSH access to the
Docker host, `ProserFactory/scripts/provision-hermes-agent-identity.sh` with
`--compose-file` for each Compose file and `--compose-env-file` for
`.env.compose` issues the secret, recreates Factory and configures the agent.
See the [Hermes plugin setup](../ProserFactory/HERMES_AGENT_PLUGIN.md).
Author browser requests continue through the same-origin `/api/*` proxy.

## Access from another machine

Keep `PROSER_WEB_BIND=127.0.0.1` and place an HTTPS reverse proxy on the Docker
host. For access limited to a Tailscale network, use
[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) with
Author's loopback port as its target. Set `PROSER_ORIGIN` in `.env.compose` to
the full HTTPS origin users open, including a port when applicable. Recreate
Author with the same Compose files so Auth.js uses the new origin. If sign-in
returns users to localhost, check this value first.

Choose the intended Author sign-in provider. Local credentials are enabled by
default in Compose. For a deployment using Magnus IAM, supply `IAM_CORE_URL`
and follow the [Author authentication settings](../ProserAuthor/docs/ENVIRONMENT.md).
Keep PostgreSQL and Redis unpublished. Use a separately authenticated private
route if agents need direct access to Factory from another host.

## Optional providers

Set `INFERENCE_HOST`, `INFERENCE_API_KEY` and `INFERENCE_MODEL` for a reachable
OpenAI-compatible text backend. Set `WEBUI_FORGE_URL` for image generation.
An address on the Docker host must be reachable from the container. Loopback
inside the Factory container addresses Factory's own container, so use
`host.docker.internal` (mapped to the Docker host by `compose.yml`) or a LAN
address instead. Proser sends selected manuscript context or image prompts to
configured providers when requested. Diagnostic content logging is disabled in
the Compose environment. Keep provider credentials and any diagnostic output
private.

`INFERENCE_API_KEY` is optional. Leave it empty for a keyless Ollama or
llama.cpp server on the Docker host or a private network; Factory starts and
logs a warning. Set it when the backend expects a bearer key, such as a hosted
API or an authenticated gateway. Set `INFERENCE_REQUIRE_API_KEY=true` to make a
missing key for a non-loopback backend a startup error; that mode also requires
a key of at least 32 characters. The models must listen on an address the
container can reach (for Ollama, `OLLAMA_HOST=0.0.0.0`).

```bash
# Ollama on the Docker host, no key
INFERENCE_BACKEND=ollama
INFERENCE_HOST=http://host.docker.internal:11434
INFERENCE_MODEL=qwen3:14b

# llama.cpp server on another machine, started with --api-key
INFERENCE_BACKEND=llamacpp
INFERENCE_HOST=http://192.168.1.20:8080
INFERENCE_API_KEY=<the server's key>
INFERENCE_MODEL=qwen3.6-35b
```

## Check and stop the installation

```bash
docker compose --env-file .env.compose -f compose.yml -f compose.factory-api.yml ps -a
curl -fsS http://localhost:3000/api/readiness
curl -fsS http://127.0.0.1:3001/api/readiness
```

The initializer exits successfully after preparing or verifying the database.
Author, Factory and the worker each report `healthy` in `ps`. The worker is
healthy once its queue consumers publish the heartbeat that Factory readiness
needs, so an unhealthy worker explains a Factory readiness of `503`.
`curl -fsS http://127.0.0.1:3001/health` and the Settings page show the running
release version and revision.
The Factory host URL is available when the Factory override is selected. For
startup failures, inspect the service logs.

```bash
docker compose --env-file .env.compose -f compose.yml -f compose.factory-api.yml logs --tail 100 initialize factory worker author
```

Stop the stack using the same Compose files and project name. If Factory was
kept internal, omit the Factory override from these commands.

```bash
docker compose --env-file .env.compose -f compose.yml -f compose.factory-api.yml down
```

`down` retains named volumes. Adding `--volumes` deletes the database, queues,
and Factory files belonging to that project.

## Back up and restore

`scripts/backup-compose.sh` writes a dated directory under `backups/` (or the
directory given with `--output`) containing:

| File                | Contents                                                    |
| ------------------- | ----------------------------------------------------------- |
| `postgres.dump`     | PostgreSQL custom-format dump (`pg_dump -Fc`)               |
| `redis-data.tar`    | The Redis data directory, including the append-only file    |
| `factory-files.tar` | The Factory `factory-data` and `factory-images` volumes     |
| `env.compose`       | A copy of `.env.compose`, which **contains all secrets**    |
| `backup.txt`        | Creation time, running image reference and ID, and revision |
| `SHA256SUMS`        | Checksums for every file, verified before any restore       |

Run it from the checkout with the same environment file, Compose files and
project name you use for the stack. For a consistent snapshot the script stops
Author, Factory, the worker and Redis while it copies, keeps PostgreSQL running
for `pg_dump`, and then starts the services that were running. Writers see a
short outage. Keep backups private, because they contain manuscripts and
`env.compose` holds every credential.

```bash
scripts/backup-compose.sh --env-file .env.compose
```

`scripts/restore-compose.sh` verifies the checksums, asks for confirmation (or
takes `--yes`), stops the application and Redis, recreates the `proser`
database from the dump, replaces the Redis data and the Factory volumes, and
starts the stack, which re-runs the `initialize` checks. It does not replace
`.env.compose`; it notes when the file differs from the backup's copy. Restore
with the image recorded in `backup.txt` so the schema matches the application,
then upgrade as usual.

```bash
scripts/restore-compose.sh --env-file .env.compose backups/proser-<timestamp>
```

Pass `-p` and `-f` to either script when the stack uses a different project name
or Compose files than the environment file selects. `scripts/test-compose-backup.sh
<image>` rehearses a backup, a change and a restore on a disposable project and
checks that the data and readiness come back.

## Remove unreferenced image files

Deleting an image in Proser keeps its file, because another image or import can
share it. To find files no image record references, run the sweep. It only
reports until you add `--apply`, and it leaves files younger than 24 hours
(`--min-age-hours=<n>`) because generation and imports write a file before the
record that points to it. Back up first.

```bash
docker compose --env-file .env.compose exec factory node dist/operations/imageOrphanSweep.js
docker compose --env-file .env.compose exec factory node dist/operations/imageOrphanSweep.js --apply
```

## Upgrades and recovery

Keep the Compose project name, existing `.env.compose`, and named volumes.
Record the running image digest, read the target release notes, and run
`scripts/backup-compose.sh` before changing versions. Switch to the matching
release checkout, update `PROSER_IMAGE`, and pull the new image.
For database changes, follow the
[document authority procedure](../ProserFactory/docs/DOCUMENT_AUTHORITY_ENFORCEMENT.md)
before starting the stack. Use a reviewed import plan for moving data from a
separate installation.

An existing installation never applies database migrations on its own. When a
release adds one, the `initialize` service exits with the pending migration
names and the application services do not start. After backing up (the backup
script works while the application is stopped) and reading the release notes,
apply the migrations with the new image, then start the stack:

```bash
docker compose --env-file .env.compose run --rm --no-deps initialize node node_modules/prisma/build/index.js migrate deploy
docker compose --env-file .env.compose up -d --no-build --wait
```

A release can also replace the document enforcement guards. The `initialize`
service applies the new guards to a database whose guards came from a known
earlier release, records the change in `proser_compose.enforcement_upgrades`,
and continues. Guards from any other source stop the start with
`Existing databases require reviewed document enforcement changes.`

For an existing production installation, rehearse the database and Redis
restore before stopping writers, for example with `scripts/restore-compose.sh`
into a separate project. Preserve the exact image reference,
PostgreSQL and Redis snapshots, assets, imports, signing material, and private
configuration. Compare PostgreSQL rows, logical Redis records, and file
digests before reopening traffic. Keep the recovery record private and
reconcile writes made after cutover before restoring an earlier snapshot.

Verify both Author and Factory readiness, protected routes, the configured
providers, and an authenticated disposable book operation with exact receipt
recovery. Record IAM transport, interactive sign-in, and signed-session
canary results according to the checks actually performed.
