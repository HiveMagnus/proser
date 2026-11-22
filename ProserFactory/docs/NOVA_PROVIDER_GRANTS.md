# Nova provider grants and shared-resource fencing

The dedicated `pnv_` credential authenticates Nova transport. It does not authorize a manuscript mutation. Every Nova request must also match an Ed25519-signed v2 grant keyed by `X-Nova-Request`. Mutating requests additionally require the exact central shared-resource claim.

Configure `PROSER_NOVA_GRANTS_FILE` as a private regular non-symlink JSON file and `PROSER_NOVA_GRANT_PUBLIC_KEY_FILE` as the issuer public key. The bounded `PROSER_NOVA_GRANTS_JSON` and `PROSER_NOVA_GRANT_PUBLIC_KEY_PEM` forms are for secret-manager injection and tests. Configure one registry and one key source.

For Ardent's Nova provider-status observation, provision an initially empty `{}` registry file owned by the `proser-factory` service user in an owner-only directory, an owner-only audit directory named by `PROSER_NOVA_GRANT_AUDIT_DIR`, and the dedicated Ardent issuer public key. Add the exact `grant:register` scope to the `nova-creative` service principal; `content:read` alone cannot register. `POST /api/nova-grants/capabilities-read` accepts only that principal, exact `X-Nova-Caller` and `X-Nova-Request`, and a verified v2 Ed25519 record for `capabilities.read` with no resource, action class, revocation or mutation authority. The record expires within five minutes. Registration durably retains the signed request record before atomically adding its immutable request ID to the private live registry; an identical retry is safe, while a different record for the same ID is denied. Expired live records are archived before pruning, and revoked records remain in the live registry. The subsequent `/api/models/status` GET still passes the normal service-principal and signed-registry checks. Registration does not authorize book reads, generation, publication, or a direct owner session.

The Ardent issuer reads a persisted, authenticated A2A task, accepted mission envelope, and open admission before signing. Its private key stays on Nova; Factory receives only the public key and signed record. A missing key, registry, or accepted task fails closed. Before activating this route, test anonymous/wrong-principal 401, wrong signature/action/resource/caller/expired/revoked 403, one exact registration, duplicate retry, and the scoped provider GET. Roll back by disabling the Ardent issuer and restoring the previous registry/configured public key; retain the old registry as evidence and do not erase unknown task outcomes.

`POST /api/nova-grants/books-read` uses the same dedicated principal and owner-only registry, but accepts only one short-lived signed `books.read` action for exactly one numeric `book:{id}` resource, with no action class or mutation authority. The caller and request ID must match the transport headers. It cannot register provider-status authority, multiple books, or `new`. A signed book grant authorizes Proser's existing read-side book resource check for the exact book; Ardent separately verifies the requested export artifact SHA-256 before exposing a local artifact receipt. The registration receipt is not proof that an export was downloaded or delivered.

`POST /api/nova-grants/generation-read` registers one short-lived signed `generation.read` action for an exact `generation:<operation-uuid>` resource. The subsequent service-principal GET can read only `/api/generate/operations/<same-uuid>`; it cannot read the artifact endpoint, list operations, cancel, or create generation work. The operation must still belong to the configured service principal's owner. Ardent's adapter additionally requires a retained task-to-operation receipt with matching owner request hash and idempotency key. The provider-side creation path alone does not make this live Nova job-status parity; Ardent must install and verify its separate TypeScript producer.

`POST /api/nova-grants/workflow-publish` registers one short-lived signed grant
for exactly one `workflow:<uuid>` with `workflows.publish`, `workflows.read`,
and `operations.read` under `external_publish`. Registration requires
`grant:register`; finalization requires `content:publish` and the full
`provider:proser:{bookId}` fence. This authority covers only an empty-body
`POST /api/workflows/{runId}/finalize`, that run's status and publication
metadata GETs, and recovery of that exact finalize operation. It cannot
approve another checkpoint, read another workflow, or fetch artifact bytes.
The finalize HTTP 202 records final checkpoint approval and dispatch; the
later owner `release_approved` workflow and publication package are the
completion proof. An absent or expired grant cannot be treated as a successful
publication, and unknown effect must be recovered by exact operation ID.
If the approval takes longer than the publish grant's lifetime, a distinct
`POST /api/nova-grants/workflow-read` registration issues one task-bound
`workflows.read` grant for the same workflow UUID, with no action class. It
permits only workflow status and publication metadata GETs. It cannot repeat
finalization, approve another checkpoint, or fetch publication bytes.

A v2 signed record binds `version`, `grant_id`, `mission_id`, `mission_revision`, `origin_task_id`, delegated `task_id`, `request_id`, `caller`, audience `proser`, `owner_actor`, exact `action_classes`, issuance and expiry, exact actions/resources, revocation, and key ID. The signature is Ed25519 over canonical JSON containing every field except `signature`. Recovery reads verify the same immutable signed identity after expiry or revocation; they do not authorize a new mutation.

Actions are exact service families, including `operations.read` for `GET /api/shared-resource-operations/{operationId}`. Resources are `new` or exact `book:`, `workflow:`, `image:`, `artifact:`, `finding:`, and `review:` identities. Wildcards are rejected. Book grants cover children only after Factory resolves their owning book. New outputs are durably request-owned and cannot be adopted by another request.

## Fenced mutations

Every Nova `POST`, `PUT`, or `PATCH` accepted by the service-principal path requires these headers:

- `X-Magnus-Fence-Set`: canonical claim JSON encoded as canonical base64url;
- `X-Magnus-Fence-Set-Sha256`;
- `X-Magnus-Lease-Id`;
- `X-Magnus-Operation-Id`;
- `X-Magnus-Request-Sha256`;
- `X-Magnus-Evidence-Domain: nova.provider-result.v1`;
- `X-Magnus-Resource-Key`;
- `X-Magnus-Fence-Generation`.

The claim binds the sorted complete `repo:`, `provider:`, and `gpu:` set; accepted mission/root revision; origin and delegated task identities; operation/request; action class; deadline; caller; and fixed owner actor. The selected Proser key is `provider:new:proser` when creating a new book, launching an unbound full-book workflow, or running a bounded editorial benchmark, and `provider:proser:{bookId}` for every other accepted mutation. Factory resolves route identifiers to their owning book and rejects an ambiguous mapping. Enabled inference routes also reserve the configured shared GPU. Nova generation and image writes therefore require an exact `bookId`.

Admission and every fence advance occur in one PostgreSQL transaction under a provider-wide PostgreSQL advisory lock. Fence generations only increase. Operation, claim, request, route, body digest, and terminal rows are immutable and append-only at the database layer; row deletion and table truncation are both rejected. Route-owned resources, including editorial proposals, are resolved from Factory's database before both grant authorization and fence admission. An exact terminal replay returns the stored response without re-running the route. An admitted workflow operation left behind before dispatch becomes signed `no_effect`; a running operation remains unresolved until its exact terminal row is available. Recovery reads can use the retained owner-only signed grant audit after the short-lived live registry entry is pruned. They do not grant mutation after expiry.

Before returning a mutation response, Factory rechecks the full fence set and signs both:

- `sharedResourceResult`, domain `nova.provider-result.v1`, containing the exact operation/claim, terminal state, route/body metadata, response digest, and bounded provider response;
- `sharedResourceEvidence`, signed over domain `magnus.shared-resource-terminal.v1`, containing the complete fence set and mission identity, outcome, evidence digest, issuer, key ID, completion time, and Ed25519 signature.

Configure the signer with an owner-only regular key at `PROSER_SHARED_RESOURCE_SIGNING_KEY_FILE`; `PROSER_SHARED_RESOURCE_SIGNING_ISSUER` defaults to `proser`. The key file and its parent must be owner-only, non-symlink paths. No key is generated by the application or deployment source.

Checkpoint-free Quality Review and Editorial Optimize launches are admitted only when the operation and durable run can be bound in the same PostgreSQL transaction. The BullMQ worker takes the shared authority lock before claiming work, rechecks the complete resource/GPU fence together with its renewable workflow lease, and seals signed terminal evidence in the same transaction as successful final publication. Redelivery reconciles a completed run whose evidence seal was interrupted. A queued run superseded before worker claim is cancelled and receives signed failure evidence without manuscript publication.

Full Book, Improve Quality, and Guided Improve launches still return signed durable `no_effect` with `SHARED_RESOURCE_ASYNC_UNSUPPORTED`: they can pause for later checkpoint decisions, and durable authority transfer between those requests is not yet implemented. Editorial benchmarks remain synchronous under the request authority lock and return signed terminal evidence only after the report is committed. Other synchronous mutation routes use the reviewed request-level fence boundary.

Delegated `POST /api/generate/operations` remains signed `no_effect` with `409 SHARED_RESOURCE_ASYNC_UNSUPPORTED` unless `PROSER_DELEGATED_GENERATION_ENABLED=true` is explicitly set on Factory. Keep it off until Ardent's typed producer, central shared-resource lease client, signed grant admission, and recovery tests pass; a provider-only code release does not activate generation. When enabled, creation requires the exact book grant, `generation.create`, `create_draft`, a provider fence, and a matching `Idempotency-Key`. Factory stores the generation UUID, key, and normalized request hash immutably in PostgreSQL before it sends the request to Redis. Redis creates that fixed UUID atomically with its idempotency index. The provider seals a signed creation receipt after reading the Redis record; its later inference status and artifact publication remain separate. An exact redelivery returns the same UUID and signed receipt. If the API stops after Redis creation but before sealing, `GET /api/shared-resource-operations/{operationId}` reconciles and seals that same Redis record under the original signed recovery authority. If PostgreSQL says dispatch began but Redis has no exact record, Factory returns `SHARED_RESOURCE_UNKNOWN_EFFECT` and never submits another generation; an operator must investigate the two stores. This conservative unknown state covers a crash before Redis creation as well as lost Redis state after creation. The generation worker rechecks the provider fence before starting and before artifact completion. Neither creation nor a status read proves an artifact was downloaded or delivered.

Activation requires the additive migration, provisioned public and terminal-signing keys, an updated v2 grant registry, coordinated Factory/API and Nova source, and explicit permission through Senti's Telegram. Source installation alone does not enable a live Nova mutation.
