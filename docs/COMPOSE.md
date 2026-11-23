# Run Proser with Docker Compose

Compose runs Author, Factory and its worker from one application image.
PostgreSQL and Redis use their own persistent volumes on an internal network.
The application image includes the pinned document renderer and publication
fonts. Configure text and image models separately if you need generation.

## First run

Use the [prebuilt-image quick start](../README.md#quick-start) for the released
`linux/amd64` image. Use the checkout matching the image's GitHub release tag.

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
inside the Factory container addresses Factory's own container. Proser sends
selected manuscript context or image prompts to configured providers when
requested. Diagnostic content logging is disabled in the Compose environment.
Keep provider credentials and any diagnostic output private.

## Check and stop the installation

```bash
docker compose --env-file .env.compose -f compose.yml -f compose.factory-api.yml ps -a
curl -fsS http://localhost:3000/api/readiness
curl -fsS http://127.0.0.1:3001/api/readiness
```

The initializer exits successfully after preparing or verifying the database.
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

## Upgrades and recovery

Keep the Compose project name, existing `.env.compose`, and named volumes.
Record the running image digest, read the target release notes, and back up
PostgreSQL, Redis, Factory data and images before changing versions. Switch to
the matching release checkout, update `PROSER_IMAGE`, and pull the new image.
For database changes, follow the
[document authority procedure](../ProserFactory/docs/DOCUMENT_AUTHORITY_ENFORCEMENT.md)
before starting the stack. Use a reviewed import plan for moving data from a
separate installation.

An existing installation never applies database migrations on its own. When a
release adds one, the `initialize` service exits with the pending migration
names and the application services do not start. After backing up and reading
the release notes, apply the migrations with the new image, then start the
stack:

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
restore before stopping writers. Preserve the exact image reference,
PostgreSQL and Redis snapshots, assets, imports, signing material, and private
configuration. Compare PostgreSQL rows, logical Redis records, and file
digests before reopening traffic. Keep the recovery record private and
reconcile writes made after cutover before restoring an earlier snapshot.

Verify both Author and Factory readiness, protected routes, the configured
providers, and an authenticated disposable book operation with exact receipt
recovery. Record IAM transport, interactive sign-in, and signed-session
canary results according to the checks actually performed.
