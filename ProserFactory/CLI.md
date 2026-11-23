# Proser CLI

`proser-cli` is a local operator interface that connects directly to Factory’s PostgreSQL database. For remote automation, use the [Factory API](../PROSER_API.md) or [Hermes](HERMES_AGENT_PLUGIN.md). Durable whole-book and editorial work belongs to Workflow v1 through the authenticated API, ProserAuthor Book Factory, or Hermes workflow tools.

The retired `pipeline` and `resume` commands do not exist. Their legacy FactoryRun state was removed so workflow retries, checkpoints, revisions, and audit events have one source of truth.

## Prerequisites

Run from `ProserFactory/` with:

- Node `24.22.1` and installed npm dependencies;
- `DATABASE_URL` pointing to the Factory PostgreSQL database;
- a reachable OpenAI-compatible inference endpoint for generation commands.

```bash
npm ci
npm run db:generate
```

The CLI initializes its database adapter before rendering help. Use a
placeholder URL to inspect help. For book operations, use the authorized
database configuration from [native development](README.md#native-development).

```bash
DATABASE_URL=postgresql://unused:fixture-only@127.0.0.1:5432/unused_fixture npm run cli -- --help
```

## Global options

| Option                   | Purpose                                              |
| ------------------------ | ---------------------------------------------------- |
| `--model <name>`         | Override the active model, for example `qwen3.6-35b` |
| `--temperature <0..2>`   | Override generation temperature                      |
| `--inference-host <url>` | Override the OpenAI-compatible endpoint              |
| `-h`, `--help`           | Show help                                            |
| `-v`, `--version`        | Show CLI version                                     |

Use `npm run cli -- <command> --help` for the executable option reference.

## Commands

### `editorial`

`editorial passes` discovers pass packs. `editorial optimize` launches a bounded
book/act/chapter/scene request. `editorial status`, `summary`, and `proposals`
inspect evidence. `editorial benchmark` runs deterministic or bounded live
Quality Lab cases. Post-run proposal application requires `editorial apply
PROPOSAL_ID --candidate ID --apply`; normal autonomous application is selected
at launch. Run `proser editorial --help` for exact flags.

### `create <prompt>`

Create a book for an existing user or the auto-created CLI user.

```bash
npm run cli -- create "A cartographer discovers a city erased from every map" \
  --genre fantasy \
  --title "The Missing Meridian"
```

Options: `--genre`, `--title`, `--user-id`, `--json`.

### `outline <bookId>`

Generate acts, chapters, and scenes for an existing book.

```bash
npm run cli -- outline 12 --acts 3 --chapters-per-act 5 --scenes-per-chapter 4
```

Options: `--acts` (default 3), `--chapters-per-act` (default 5), `--scenes-per-chapter` (default 4), `--json`.

### `characters <bookId>`

Generate character profiles and add them to the book's codex.

```bash
npm run cli -- characters 12
```

Option: `--json`.

### `generate <bookId>`

Generate prose for every planned scene or one named scene.

```bash
npm run cli -- generate 12
npm run cli -- generate 12 --scene-id 44
npm run cli -- generate 12 --use-rag=false
```

Options: `--scene-id`, `--use-rag` (default true), `--json`.

### `review <bookId>`

Run the CLI's local quality skills over every scene or one scene. This is not a durable Workflow v1 Quality Review and does not create a `WorkflowRun`.

```bash
npm run cli -- review 12
npm run cli -- review 12 --scene-id 44
```

Options: `--scene-id`, `--json`.

### `revise <bookId>`

Revise scenes from local skill findings or a custom instruction.

```bash
npm run cli -- revise 12
npm run cli -- revise 12 --scene-id 44 --instruction "Tighten the dialogue"
```

Options: `--scene-id`, `--instruction`, `--json`.

### `export <bookId>`

Write a local manuscript export.

```bash
npm run cli -- export 12 --format epub --output-dir ./output
```

Formats: `markdown`, `txt`, `html`, `epub`, `json`. The default format is `markdown`; the default directory is `./output`.

### `status <bookId>`

Show book metadata, structure, and prose completion.

```bash
npm run cli -- status 12 --json
```

### `codex:list <bookId>`

List codex entries, optionally filtered by type.

```bash
npm run cli -- codex:list 12 --type character
```

Options: `--type`, `--json`.

### `codex:add <bookId> <name> <description>`

Create one codex entry.

```bash
npm run cli -- codex:add 12 "The Glass Orchard" "Trees whose fruit replay buried memories." \
  --type location
```

Options: `--type` (default `character`), `--json`.

### `list`

List books for the auto-created CLI user or a specific database user.

```bash
npm run cli -- list
npm run cli -- list --user-id 42 --json
```

## Durable whole-book work

Use one of these instead of scripting CLI stages as a background pipeline:

- `POST /api/workflows/full-book`
- `POST /api/workflows/quality-review`
- `POST /api/workflows/improve-quality`
- `POST /api/workflows/guided-improve`
- ProserAuthor's `/workflows` Book Factory desk
- Hermes `proser_full_book`, `proser_quality_review`, `proser_improve_quality`, or `proser_guided_improve`

Workflow launch calls require `Idempotency-Key` and continue in `proser-worker` after the caller disconnects. See [`docs/WORKFLOW_V1.md`](docs/WORKFLOW_V1.md) and [`../PROSER_API.md`](../PROSER_API.md).

## Troubleshooting

`DATABASE_URL environment variable is required` means the CLI could not load a database URL before command parsing. Export it or put it in `.env`/`.env.local`.

Inference failures should be checked against `INFERENCE_HOST` (preferred) and the active model settings. `--inference-host` and `--model` are invocation-local overrides.

Use `--json` for automation. Human output includes progress formatting and is not a stable machine contract.
