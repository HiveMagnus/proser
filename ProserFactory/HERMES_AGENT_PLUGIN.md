# Hermes Agent Proser Plugin

The Proser plugin lets Hermes read book context and start or observe durable
Factory workflows. Factory owns manuscript data and workflow progress.

## Connect an agent

1. Start Proser and identify the Factory origin reachable from the agent.
   Use `http://127.0.0.1:3001` only for a same-host agent with the Factory
   port enabled. Use a private HTTPS origin for an agent on another host.
   Omit the `/api` suffix. [Direct Factory access](../docs/COMPOSE.md#direct-factory-api-access)
2. Arrange a dedicated Hermes service identity with the Factory operator.
   Set `HERMES_AGENT_AUTH_SECRET` and put the service identity in
   `HERMES_AGENT_ALLOWED_GITHUB_IDS` on Factory, then recreate the Compose
   Factory service with those settings. Use a service ID such as
   `service:hermes-agent:agent-host` and keep the Hermes signing secret
   separate from Author's signing secret.
3. From the repository root, run the installer against the Ubuntu Hermes host.
   Set the shell variables below to your SSH configuration, Factory origin,
   service identity, and the path to an owner-only secret file.

```bash
bash ProserFactory/scripts/deploy-hermes-proser-plugin-ubuntu24.sh \
  --host agent-host \
  --user "$PROSER_USER" \
  --identity-file "$PROSER_SSH_KEY" \
  --known-hosts-file "$PROSER_SSH_KNOWN_HOSTS" \
  --proser-base-url "$FACTORY_ORIGIN" \
  --proser-auth-secret-file "$HERMES_SECRET_FILE" \
  --proser-github-id "$HERMES_SERVICE_ID" \
  --restart-service hermes-gateway.service
```

Use `--proser-token-file` in place of `--proser-auth-secret-file` for a
pre-issued token. Use `--skip-env` for updates to an already enrolled host.
Omit `--restart-service` if you manage the gateway separately. The installer
verifies the plugin, the current skill links and the gateway when restarted.

Call `proser_books` with `{"action":"list_books"}` to verify access. An empty
list is valid for a new identity. Use `proser_context` for bounded manuscript
context and `proser_exports` for existing export artifacts. Check the Factory
origin and the identity allowlist if the read fails. [Factory API](../PROSER_API.md)

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

The plugin also exposes scoped tools for books, exports, codex, context,
one-shot generation, settings, models and images.

## Bundled skills

The deploy script installs and links only these skills:

- `proser-authoring`
- `proser-workflows`
- `proser-book-reader`
- `proser-codex-entry-designer`
- `proser-editorial`

Managed Nova writes derive the central provider fence from an exact positive `bookId` (top-level or request body), an explicitly unbound book-creation action, or a bounded editorial benchmark. Workflow controls, checkpoint/finalization, generation, image writes, codex updates, finding decisions, and editorial proposal mutations require the owning `bookId` before central reservation; a run/image/finding identifier is never substituted for a book fence. Checkpoint-free Quality Review and Editorial Optimize launches bind the provider operation to one durable run and publish signed evidence only after a fence-aware worker reaches its terminal state. Full Book and checkpoint-capable improvement launches remain fail closed pending durable continuation-authority transfer. Redis-backed durable prose-operation launches remain fail closed because their artifact store and PostgreSQL evidence journal do not yet have one atomic publication boundary.

Hermes discovers the five linked skills under `~/.hermes/skills/writing`.
The installer replaces the code under `~/.hermes/plugins/proser-api`, preserves
its host-specific `.env` and CA certificate, and removes retired Proser links.

## Configuration

The plugin loads `PROSER_BASE_URL` and credentials from its local `.env`.
`PROSER_TOKEN` takes precedence when set. Otherwise the plugin uses
`PROSER_AUTH_SECRET` and `PROSER_GITHUB_ID` to sign short-lived tokens.
The default issuer is `hermes-agent` and the audience is `proser-factory`.
Both values must match Factory. TLS verification is enabled. Set
`PROSER_CA_FILE` on the agent if the endpoint uses a private CA.

### Run on behalf of an author

Set `PROSER_OWNER_GITHUB_ID` to the existing author's Factory identity on the agent
and allow that owner with `HERMES_AGENT_ALLOWED_OWNER_GITHUB_IDS` on Factory.
In a Compose deployment, pass the owner allowlist into the Factory service
with a private Compose override. The signed token retains the service
identity as the audit actor and the delegated author owns the books and
workflows, so those runs appear in Author. Both allowlists must match.

For a native systemd Factory deployment, the
`scripts/provision-hermes-agent-identity.sh --agent-host HOST --owner-github-id AUTHOR_ID`
helper configures the native Factory environment and enrolls a Hermes host.

## Small-model operating rules

- Prefer one workflow start call followed by status polling; repeated identical starts are deduplicated while active.
- Never synthesize review payloads or submit `{}` artifact bodies.
- Treat `202` as accepted background work, not as a request to keep a tool call open.
- Decide pending checkpoints explicitly; do not bypass them with resume.
- If structured model output fails its bounded repair attempts, the workflow pauses with visible failure state instead of looping.

See the [workflow guide](docs/WORKFLOW_V1.md) for API behavior, revision rules,
release gates and recovery.
