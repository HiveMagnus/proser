# Proser

Proser is a self-hosted writing studio for long-form fiction. Draft and revise
manuscripts on desktop or mobile, maintain a story bible, and export DOCX and
EPUB. Connect compatible model providers to use AI-assisted writing and images.

## Quick start

Install Git, Docker with the Compose plugin, and Node.js. Clone the repository
and run:

```bash
git clone https://github.com/HiveMagnus/proser.git
cd proser
node scripts/init-compose-env.mjs
docker compose --env-file .env.compose up -d --build --wait
```

Open [http://localhost:3000](http://localhost:3000). Sign in with
`LOCAL_AUTH_USERNAME` and `LOCAL_AUTH_PASSWORD` from the generated
`.env.compose` file. Keep the file with your installation and backups.
Compose starts Author, Factory, and the worker from **one application image**.
PostgreSQL, Redis, manuscripts, and images persist in named volumes.

## Initial configuration

| Setting                                                  | When to change it                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------- |
| `INFERENCE_HOST`, `INFERENCE_API_KEY`, `INFERENCE_MODEL` | Connect a reachable OpenAI-compatible endpoint for text generation. |
| `WEBUI_FORGE_URL`                                        | Connect a compatible image provider.                                |
| `PROSER_WEB_PORT`, `PROSER_ORIGIN`                       | Select a different web port and update the browser URL to match.    |
| `LOCAL_AUTH_USERNAME`, `LOCAL_AUTH_PASSWORD`             | Change the local login credentials.                                 |

The generated config enables direct Factory access at `http://127.0.0.1:3001`
for CLI and agent clients. Use the base Compose file to keep Factory internal:

```bash
docker compose --env-file .env.compose -f compose.yml up -d --wait
```

Text and image providers run separately. The app can start and edit documents
without them. See [Compose configuration](docs/COMPOSE.md) for network access,
authentication, persistent volumes, and upgrades.

## Development and documentation

- [Architecture](APP_ARCHITECTURE.md) and [Factory API](PROSER_API.md)
- [Factory development](ProserFactory/README.md) and
  [Author development](ProserAuthor/README.md)
- [Continuous integration](docs/CI.md) and [project guidance](AGENTS.md)
- [Canvas acceptance](CANVAS_R2_ACCEPTANCE.md) and
  [revision campaigns](ProserAuthor/docs/REVISION_CAMPAIGNS.md)

## License

Proser is available under the [Apache License 2.0](LICENSE). Bundled third-party
code retains its original licenses and notices. See [NOTICE](NOTICE).
