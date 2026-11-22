# Run Proser with Docker Compose

Compose runs Author, Factory and its worker from one application image.
PostgreSQL and Redis use their own persistent volumes on an internal network.
The application image includes the pinned document renderer and publication
fonts. Configure text and image models separately if you need generation.

## First run

From a committed checkout with Docker Compose and Node installed:

```bash
node scripts/init-compose-env.mjs
docker compose --env-file .env.compose up -d --build --wait
```

Open `http://localhost:3000` and sign in with `LOCAL_AUTH_USERNAME` and
`LOCAL_AUTH_PASSWORD` from the owner-only `.env.compose` file. Keep that file
with the deployment and its backups. The initialization script creates distinct
random credentials and preserves any existing environment file. If you change
the web port, update `PROSER_ORIGIN` to match the URL you use in the browser.
Set `PROSER_REVISION` to the source commit when building a newer checkout.

For an image that is already built, set `PROSER_IMAGE` to its local tag and
start Compose with `--no-build`. Author, Factory, the worker and the database
initializer must all use that same image.

The initializer installs or verifies the reviewed document-enforcement SQL.
Automatic activation runs only against a fresh Compose-managed database. On
subsequent starts it checks the saved activation evidence and migration status.
Review and apply pending migrations to an existing database through the
project's [database procedure](../ProserFactory/docs/DOCUMENT_AUTHORITY_ENFORCEMENT.md)
before starting an upgraded stack. Use a separately reviewed import plan when
moving existing production data. Preserve PostgreSQL, Redis, Factory data and
image volumes. Ordinary `docker compose down` retains named volumes.

## Direct Factory API access

The generated local test environment selects `compose.factory-api.yml` and
opens Factory on `http://127.0.0.1:3001` for local agents and CLI tools.
Select only `compose.yml` to keep Factory inside the Compose network:

```bash
docker compose --env-file .env.compose -f compose.yml up -d
```

Add the override again to publish it. Change `PROSER_FACTORY_BIND` and
`PROSER_FACTORY_PORT` to select a different host socket. Keep the bind on
loopback for a local HTTPS reverse proxy. An agent on another host should use
an authenticated TLS endpoint and its own scoped Factory credential. The
[Factory API](../PROSER_API.md) describes authentication and endpoints. For
Hermes, configure a separate `HERMES_AGENT_AUTH_SECRET` and the permitted
agent identities in `HERMES_AGENT_ALLOWED_GITHUB_IDS`. See the
[Hermes plugin setup](../ProserFactory/HERMES_AGENT_PLUGIN.md).
Author browser requests continue through the same-origin `/api/*` proxy.

## Providers and data

Set `INFERENCE_HOST`, `INFERENCE_API_KEY` and `INFERENCE_MODEL` for a reachable
OpenAI-compatible text backend. Set `WEBUI_FORGE_URL` for image generation.
An address on the Docker host must be reachable from the container. Loopback
inside the Factory container addresses Factory's own container. Proser sends
selected manuscript context or image prompts to configured providers when
requested. Diagnostic content logging is disabled in the Compose environment.
Keep provider credentials and any diagnostic output private.

For a network deployment, serve Author through HTTPS, set `PROSER_ORIGIN` to
its external URL, and configure the intended authentication provider. Supply
certificate keys and provider credentials in owner-only deployment files.
Keep PostgreSQL and Redis unpublished. A host-specific Compose file can set
TLS, the production authentication origin, and existing volume bindings.

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
