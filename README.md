# Proser

Proser is a self-hosted writing studio for long-form fiction. Draft and revise
manuscripts on desktop or mobile, maintain a story bible, and export DOCX and
EPUB. Connect compatible model providers to use AI-assisted writing and images.

## Quick start

Install Git, Docker with the Compose plugin, and Node.js `24.22.1`. The prebuilt
image is `linux/amd64`. Run these commands in Bash from a fresh checkout.

```bash
git clone --branch v1.0.1 https://github.com/HiveMagnus/proser.git
cd proser
node scripts/init-compose-env.mjs
printf '\nPROSER_IMAGE=ghcr.io/hivemagnus/proser:1.0.1\n' >> .env.compose
docker pull ghcr.io/hivemagnus/proser:1.0.1
docker compose --env-file .env.compose -f compose.yml -f compose.factory-api.yml up -d --no-build --wait
```

Open [http://localhost:3000](http://localhost:3000). Sign in with
`LOCAL_AUTH_USERNAME` and `LOCAL_AUTH_PASSWORD` from the generated owner-only
`.env.compose` file. Keep that file with your installation and backups. Localhost
refers to the machine running Docker. For access from another machine, use the
[HTTPS setup](docs/COMPOSE.md#access-from-another-machine).
Compose starts Author, Factory, and the worker from **one application image**.
PostgreSQL, Redis, manuscripts, and images persist in named volumes.

Start writing with **New Project** on desktop or **Quick Draft** on a phone.

For a source build or an upgrade of an existing installation, follow the
[Compose guide](docs/COMPOSE.md).

## Initial configuration

| Setting                                                  | When to change it                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| `INFERENCE_HOST`, `INFERENCE_API_KEY`, `INFERENCE_MODEL` | Connect a reachable OpenAI-compatible endpoint for text generation. |
| `WEBUI_FORGE_URL`                                        | Connect a compatible image provider.                                |
| `PROSER_WEB_PORT`, `PROSER_ORIGIN`                       | Select a different web port and update the browser URL to match.    |
| `LOCAL_AUTH_USERNAME`, `LOCAL_AUTH_PASSWORD`             | Change the local login credentials.                                 |

The generated config enables direct Factory access at `http://127.0.0.1:3001`
for API and agent clients. Use the base Compose file to keep Factory internal.

```bash
docker compose --env-file .env.compose -f compose.yml up -d --no-build --wait
```

Text and image providers run separately. The app can start and edit documents
without them. See [Compose configuration](docs/COMPOSE.md) for network access,
authentication, persistent volumes, and upgrades.

## Documentation

- Install and operate Proser with the [Compose guide](docs/COMPOSE.md) and
  [release notes](https://github.com/HiveMagnus/proser/releases).
- Write and revise using the [manuscript workspace](ProserAuthor/docs/STRUCTURED_EDITOR.md),
  [mobile guide](ProserAuthor/docs/MOBILE.md), and
  [revision campaigns](ProserAuthor/docs/REVISION_CAMPAIGNS.md).
- Connect agents and scripts with the [Factory API](PROSER_API.md),
  [Hermes plugin](ProserFactory/HERMES_AGENT_PLUGIN.md), or
  [local operator CLI](ProserFactory/CLI.md).
- Contribute with [project guidance](AGENTS.md), [architecture](APP_ARCHITECTURE.md),
  [Factory development](ProserFactory/README.md), [Author development](ProserAuthor/README.md),
  and [CI checks](docs/CI.md).

## License

Proser is available under the [Apache License 2.0](LICENSE). Bundled third-party
code retains its original licenses and notices. See [NOTICE](NOTICE).
