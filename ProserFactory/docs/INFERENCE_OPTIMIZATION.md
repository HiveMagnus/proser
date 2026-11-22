# Proser inference optimization

## Selected inference-host profile

The versioned service definition is `deploy/inference/llama-qwen3.6.service`; deploy it with `scripts/deploy-inference.sh`.

- Qwen3.6 35B-A3B Q6_K_P across three RTX 3090 GPUs.
- Eight continuously batched slots, 1,200,000 aggregate context, approximately 150K tokens per slot.
- Vision remains enabled through the f16 `mmproj`.
- Flash Attention remains `auto`; forcing it on changed throughput by less than 1%.
- K/V caches use `q8_0`. This preserved validation and throughput while freeing approximately 1–2 GB on every GPU.
- Missing request controls default to non-thinking output. Explicit planning requests may enable thinking, with a 1,024-token host ceiling.
- The host fallback sampler is Qwen's general non-thinking profile. Proser sends task-specific parameters on normal requests.

## Proser task profiles

| Profile      | Thinking                     | Purpose                                      |
| ------------ | ---------------------------- | -------------------------------------------- |
| `structured` | Off                          | JSON artifacts, exact patches, extraction    |
| `critic`     | Off                          | Quality findings and verification            |
| `prose`      | Off                          | Scene drafting against established contracts |
| `planning`   | On, 768-token request budget | Architecture and developmental reasoning     |
| `revision`   | Off                          | Localized manuscript repairs                 |

Workflow artifacts use llama.cpp JSON Schema constraints and semantic validation. Invalid structured output receives one repair attempt. Empty visible output, reasoning-only output, and prematurely exhausted structured responses are failures and enter the workflow's bounded retry/pause path.

## Measured results

Measurements were taken on 2026-07-19 with the checked-in benchmark harness. Small samples establish deployment safety; use at least five iterations when comparing future runtime or model changes.

| Check                                           | Result                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| Workflow tool selection and populated arguments | 120/120; 30 per workflow scenario                                                  |
| Strict JSON parsing and schema validity         | 50/50                                                                              |
| Thinking off visible output / leakage           | 2/2, zero leakage                                                                  |
| 256-token thinking visible output / leakage     | 2/2, zero leakage                                                                  |
| 768-token thinking visible output / leakage     | 2/2, zero leakage                                                                  |
| 128K-token labeled-fact retrieval with q8 KV    | Correct, 128,079 prompt tokens                                                     |
| q8 KV versus f16 throughput                     | Within 2% at 1, 4, and 8 slots                                                     |
| Vision versus text-only throughput              | Within 1% at 1 and 8 slots                                                         |
| Vision GPU cost                                 | Approximately 1.1 GB on GPU 0                                                      |
| Deployed Full Book architecture                 | 12 scenes, complete artifacts, correct approval checkpoint                         |
| Deployed API smoke                              | 27/27 in the recorded 2026-07-19 run; the current harness contains up to 31 checks |
| Hermes workflow-tool smoke                      | Correct structured `404 NOT_FOUND`, no repeated call                               |

Eight-slot aggregate generation measured about 153–154 completion tokens/second in the controlled run. Direct non-thinking responses averaged about 0.51 seconds, 256-token reasoning about 3.0 seconds, and 768-token reasoning about 6.5 seconds.

## Regression procedure

Run:

```bash
npm run benchmark:inference -- --iterations=5
npm run typecheck
npm run lint
npm test
npm run build
```

Retain a candidate only when:

- tool selection is at least 99% and arguments are always parseable and non-empty;
- structured output is 100% parseable and schema-valid;
- no mode returns reasoning-only output or leaks planning into visible content;
- deterministic prose gates do not regress;
- throughput or memory improvement is material, with no OOM or context-capacity loss.

The inference deploy script backs up the installed unit with a UTC suffix. Roll back by restoring that unit, restoring the preceding versioned template, running `systemctl daemon-reload`, and restarting `llama-qwen3.6.service`.
