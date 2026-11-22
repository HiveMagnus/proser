# Editorial pass packs

Pass definitions live in `src/services/editorial/passRegistry.ts`. Startup
validates unique keys, semantic versions, supported scopes, detector and critic
references, recipes, preservation rules, risk limits, and budgets. Discovery
is available through API, CLI, Hermes, and Author.

| Pass | Intent | Automatic boundary |
| --- | --- | --- |
| `line_edit_safe` | clarity, cadence, repetition, sentence shape | low-risk local wording |
| `dialogue` | dialogue distinction and attribution | preserves speaker, intent, and facts |
| `voice_preservation` | narrator and character voice fidelity | rejects flattening/convergence |
| `scene_energy` | scene momentum and focus | no structural or outcome changes |
| `continuity` | canon, chronology, state, and relationship conflicts | analysis-first; only supported local fixes |
| `name_originality` | repetition, similarity, phonetic and cross-book collisions | never auto-renames |
| `final_polish` | conservative release polish | all hard invariants and drift checks |
| `custom` | bounded user objective | inherits protected elements and policy ceilings |

Passes combine deterministic detectors, seven contextual critic profiles,
candidate and judge recipes, and the centralized `editorial-policy-v1`.
Adding a pass requires a versioned registry entry, detector/critic contract
tests, corpus cases, OpenAPI discovery compatibility, and documentation here.
Changing behavior requires a version bump; do not silently mutate historical
meaning.
