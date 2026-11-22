# Hermes Agent Proser Plugin

The Proser plugin exposes compact, action-specific tools for book data and the clean-slate Workflow v1 platform. Hermes starts and observes durable server-side work; it never uploads manuscript-sized artifacts or manually advances internal tasks.

## Workflow tools

| Tool                                          | Purpose                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| `proser_full_book`                            | Start architecture, drafting, editorial rounds, validation, and publication.   |
| `proser_quality_review`                       | Start an immutable, read-only review against one manuscript revision.          |
| `proser_improve_quality`                      | Implement selected stored findings with safe-edit gates.                       |
| `proser_guided_improve`                       | Apply a free-form author instruction with impact checkpoints.                  |
| `proser_editorial_optimize`                   | Launch one bounded, checkpoint-free editorial goal.                            |
| `proser_editorial`                            | Discover passes and read compact editorial/profile/Quality Lab evidence.       |
| `proser_workflow_status`                      | Read compact progress, heartbeat, manuscript, child-run, and checkpoint state. |
| `proser_workflow_checkpoint`                  | Approve or reject one pending checkpoint.                                      |
| `proser_workflow_pause` / `resume` / `cancel` | Control a durable run at safe boundaries.                                      |
| `proser_publication`                          | Read publication gates, manifest, and release state.                           |

The plugin also retains scoped utility tools for books, exports, codex, bounded context, one-shot generation, settings, models, and images. The retired Factory, Wizard, NovelRun, ReviewRun, quality-scan, and continuity-scan tools are intentionally absent.

## Bundled skills

The deploy script installs and links only these skills:

- `proser-authoring`
- `proser-workflows`
- `proser-book-reader`
- `proser-codex-entry-designer`
- `proser-editorial`

Managed Nova writes derive the central provider fence from an exact positive `bookId` (top-level or request body), an explicitly unbound book-creation action, or a bounded editorial benchmark. Workflow controls, checkpoint/finalization, generation, image writes, codex updates, finding decisions, and editorial proposal mutations require the owning `bookId` before central reservation; a run/image/finding identifier is never substituted for a book fence. Checkpoint-free Quality Review and Editorial Optimize launches bind the provider operation to one durable run and publish signed evidence only after a fence-aware worker reaches its terminal state. Full Book and checkpoint-capable improvement launches remain fail closed pending durable continuation-authority transfer. Redis-backed durable prose-operation launches remain fail closed because their artifact store and PostgreSQL evidence journal do not yet have one atomic publication boundary.

Hermes' normal discovery path is `~/.hermes/skills/writing`. The source remains under `~/.hermes/plugins/proser-api/skills`, and the deploy script creates four symlinks while removing retired Proser links. Deployment clean-replaces the plugin directory but preserves its host-specific `.env` and CA certificate.

## Configuration

The plugin loads its local `.env`. Required settings are:

- `PROSER_BASE_URL`, normally `https://proser.example.com:3001`
- either `PROSER_TOKEN` or `PROSER_AUTH_SECRET`

Signed service identities use the configured issuer and audience. Read and generation timeouts are bounded independently, responses are size-limited, TLS verification remains enabled, and errors return a stable JSON envelope with retry guidance.

For an author-facing agent, enroll the service with `scripts/provision-hermes-agent-identity.sh --agent-host HOST --owner-github-id AUTHOR_ID`. The signed token retains the service identity as the audit actor while the allow-listed existing author owns the book and workflow, so Hermes-created runs remain visible in ProserAuthor. Delegation fails closed when either the service identity or owner is absent from the Factory allowlists.

## Deployment

```bash
scripts/deploy-hermes-proser-plugin-ubuntu24.sh \
  --host agent-host \
  --user "$PROSER_USER" \
  --identity-file "$PROSER_SSH_KEY" \
  --known-hosts-file "$PROSER_SSH_KNOWN_HOSTS" \
  --skip-env \
  --restart-service hermes-gateway.service
```

Use the same command for `archie`. `--skip-env` preserves the enrolled host identity. The installer verifies plugin files, current skill links, absence of retired links, and the restarted gateway.

## Small-model operating rules

- Prefer one workflow start call followed by status polling; repeated identical starts are deduplicated while active.
- Never synthesize review payloads or submit `{}` artifact bodies.
- Treat `202` as accepted background work, not as a request to keep a tool call open.
- Decide pending checkpoints explicitly; do not bypass them with resume.
- If structured model output fails its bounded repair attempts, the workflow pauses with visible failure state instead of looping.

See `docs/WORKFLOW_V1.md` for API behavior, revision rules, release gates, and recovery semantics.
