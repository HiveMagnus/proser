/**
 * Prose generation, beats, review, repair, and fallback prompt templates.
 * @module prompts/templates/prose
 */
import type { PromptTemplate } from '@/types';

export const prosePrompts: Record<string, PromptTemplate> = {
  prose: {
    id: 'default-prose',
    name: 'Default Prose Generator',
    description: 'Generates engaging prose for scenes and chapters',
    version: '1.0.0',
    updatedAt: '2025-08-29',
    template: `TASK
Write the scene as polished fiction.

CONTEXT
{genre ? \`Genre: \${genre}\` : ''}
{archetypeDescription ? \`Archetype (tone & story shape): \${archetypeDescription}\` : ''}
{writingStyle ? \`Narrative POV: \${writingStyle} person perspective\` : 'Narrative POV: third-person limited, past tense'}
{summary ? \`Story Context: \${summary}\` : ''}
{characters ? \`Characters: \${characters}\` : ''}
{sceneContext ? \`Scene Context: \${sceneContext}\` : ''}
{wordCount ? \`Target Length: \${wordCount} words\` : 'Target Length: ~900 words'}

WRITING GOALS
- vivid, concrete sensory detail
- purposeful scene movement and emotional progression
- natural dialogue and character interaction
- continuity with the provided context
- show more than tell

OUTPUT CONTRACT
- Output ONLY the scene prose.
- Start with the first sentence of the story immediately.
- No planning, outlines, commentary, labels, headings, markdown, bold, or italics.
- No placeholders such as <character>, {{variable}}, or TODO.`,
    category: 'prose',
    isDefault: true,
    variables: ['title', 'genre', 'archetypeDescription', 'writingStyle', 'summary', 'characters', 'sceneContext', 'wordCount'],
  },

  'scene-brief': {
    id: 'default-scene-brief',
    name: 'Scene Brief Builder',
    description: 'Builds a normalized scene brief for staged prose generation',
    version: '2.0.0',
    updatedAt: '2026-03-28',
    template: `SCENE BRIEF
{title ? \`Book: \${title}\` : ''}
{genre ? \`Genre: \${genre}\` : ''}
{genreKey ? \`Canonical Genre: \${genreKey}\` : ''}
{archetypeDescription ? \`Archetype: \${archetypeDescription}\` : ''}
{writingStyle ? \`Narrative Style: \${writingStyle}\` : ''}
{pov ? \`POV: \${pov}\` : ''}
{tense ? \`Tense: \${tense}\` : ''}
{summary ? \`Story Summary: \${summary}\` : ''}
{sceneContext ? \`Scene Context:\n\${sceneContext}\` : ''}
{characters ? \`Characters: \${characters}\` : ''}
{instructions ? \`Author Instructions:\n\${instructions}\` : ''}
{mustInclude ? \`Must Include: \${mustInclude}\` : ''}
{mustAvoid ? \`Must Avoid: \${mustAvoid}\` : ''}
{ragSection ? \`Reference Context:\n\${ragSection}\` : ''}
{wordCount ? \`Target Words: \${wordCount}\` : ''}`,
    category: 'scene-brief',
    isDefault: true,
    variables: ['title', 'genre', 'genreKey', 'archetypeDescription', 'writingStyle', 'pov', 'tense', 'summary', 'sceneContext', 'characters', 'instructions', 'mustInclude', 'mustAvoid', 'ragSection', 'wordCount'],
  },

  'prose-draft': {
    id: 'default-prose-draft',
    name: 'Staged Prose Draft Generator',
    description: 'Generates prose from a structured brief and optional scene beats',
    version: '2.0.0',
    updatedAt: '2026-03-28',
    template: `TASK
Write polished fiction from the brief below.

SOURCE OF TRUTH
Use the brief as the source of truth for genre, continuity, named facts, and author intent.

{sceneBrief}

{beatsJson ? \`Scene Beats (follow these closely):\n\${beatsJson}\n\n\` : ''}{targetBand ? \`Target length: \${targetBand}.\n\` : ''}{mustInclude ? \`Required inclusions: \${mustInclude}.\n\` : ''}{mustAvoid ? \`Avoid completely: \${mustAvoid}.\n\` : ''}REQUIREMENTS
- Start with the first sentence of the story immediately.
- Stay in the requested POV and tense.
- Keep names, facts, and continuity consistent.
- Use concrete sensory detail and purposeful scene movement.
- No placeholders like <character>, {{variable}}, or TODO.

OUTPUT CONTRACT
- Output ONLY the final prose scene.
- Do not add plans, reasoning, commentary, headings, labels, code fences, or notes.`,
    category: 'prose-draft',
    isDefault: true,
    variables: ['sceneBrief', 'beatsJson', 'targetBand', 'mustInclude', 'mustAvoid'],
  },

  'prose-revise': {
    id: 'default-prose-revise',
    name: 'Targeted Prose Revision',
    description: 'Revises prose to satisfy validator failures while preserving the scene',
    version: '2.0.0',
    updatedAt: '2026-03-28',
    template: `TASK
Revise the draft so it satisfies the brief and fixes the validator failures.

PRIORITIES
- Preserve the underlying scene, voice, pacing, and important story beats.
- Change only what is needed to satisfy the brief and fix the listed failures.
- Keep named facts, chronology, POV, and tense consistent unless the brief explicitly requires a change.

BRIEF
{sceneBrief}

VALIDATOR FAILURES
{validatorFailures}

{mustInclude ? \`Required inclusions: \${mustInclude}\n\` : ''}{mustAvoid ? \`Avoid completely: \${mustAvoid}\n\` : ''}DRAFT
---
{draftText}
---

OUTPUT CONTRACT
- Return only the revised prose.
- No commentary, headings, notes, or change summaries.`,
    category: 'prose-revise',
    isDefault: true,
    variables: ['sceneBrief', 'validatorFailures', 'mustInclude', 'mustAvoid', 'draftText'],
  },

  beats: {
    id: 'default-beats',
    name: 'Default Beats Generator',
    description: 'Plans scene beats as structured JSON for prose generation',
    version: '1.0.0',
    updatedAt: '2025-08-29',
    template: `TASK
Plan the scene as strict JSON with keys {"beats": string[5..8], "pov": "first|third", "tense": "past|present", "target_words": number}.

OUTPUT CONTRACT
- Output ONLY valid JSON.
- No markdown, no code fences, no commentary, no extra keys.

{bookTitle ? \`Book: \${bookTitle}\` : ''}
{chapterTitle ? \`Chapter: \${chapterTitle}\` : ''}
{chapterSummary ? \`Chapter summary: \${chapterSummary}\` : ''}
{recapPrev ? \`Previous chapter recap: \${recapPrev}\` : ''}
{codex ? \`Codex context:\${codex.map(c => \`\\n- [\${c.entryType}] \${c.entryName}: \${c.entryDescription || ''}\`.trim()).join('')}\` : ''}
Aim for target_words ≈ {targetWords || 900}.`,
    category: 'beats',
    isDefault: true,
    variables: ['bookTitle', 'chapterTitle', 'chapterSummary', 'recapPrev', 'codex', 'targetWords'],
  },

  'prose-from-beats': {
    id: 'default-prose-from-beats',
    name: 'Default Prose from Beats Generator',
    description: 'Generates prose from structured beats JSON with style constraints',
    version: '1.0.0',
    updatedAt: '2025-08-29',
    template: `{priorSummary ? \`Previous scene summary (for continuity; do not repeat it verbatim):\n\${priorSummary.trim()}\n\n\` : ''}{archetypeDescription ? \`Story Archetype (tone & shape): \${archetypeDescription}\n\n\` : ''}TASK
Write a cohesive, engaging scene based on these beats (strict JSON):

{beatsJson}

Target length: {wordsRange || '~800-1200 words'}. {pov ? \`POV: \${pov}.\` : ''} {tense ? \`Tense: \${tense}.\` : ''}

GUARDRAILS
{guardrails ? guardrails.map(r => \`- \${r}\`).join('\\n') : '- Stay consistent with names and facts.\\n- No placeholders like <character> or {{...}}.\\n- Avoid meta-commentary or system messages.\\n- Do not use any emphasis in your response, including bolding or italics.'}`,
    category: 'prose-from-beats',
    isDefault: true,
    variables: ['beatsJson', 'priorSummary', 'archetypeDescription', 'wordsRange', 'pov', 'tense', 'guardrails'],
  },

  'prose-review': {
    id: 'default-prose-review',
    name: 'Default Prose Review',
    description: 'Reviews and lightly revises prose for consistency and quality',
    version: '1.0.0',
    updatedAt: '2025-08-29',
    template: `TASK
Lightly revise the scene to fix tense/POV consistency, remove repetition, and follow the author instruction if one is provided.

CONSTRAINTS
- Limit changes to about {maxEditPct || 10}% of the text.
- Preserve the scene's intent, meaning, cadence, and named facts.
- Keep edits local and surgical unless the instruction explicitly requires broader change.
- {pov ? \`POV must remain \${pov}.\` : 'Preserve the existing POV.'}
- {tense ? \`Tense must remain \${tense}.\` : 'Preserve the existing tense.'}

{instruction ? \`AUTHOR INSTRUCTION: \${instruction}\` : ''}

{sceneOutline ? \`SCENE CONTEXT:\n\${sceneOutline}\` : ''}

OUTPUT CONTRACT
- Output only the revised prose.
- No commentary, notes, headings, or explanations.

---
{originalText}
---`,
    category: 'prose-review',
    isDefault: true,
    variables: ['maxEditPct', 'pov', 'tense', 'instruction', 'sceneOutline', 'originalText'],
  },

  'prose-repair': {
    id: 'default-prose-repair',
    name: 'Default Prose Repair',
    description: 'Repairs prose by removing placeholders and minor artifacts while preserving voice and meaning',
    version: '1.0.0',
    updatedAt: '2025-08-29',
    template: `TASK
Revise the following scene to remove placeholders and minor artifacts.

CONSTRAINTS
- Preserve voice, meaning, continuity, and scene flow.
- Make the smallest effective set of changes.

OUTPUT CONTRACT
- Output only the revised prose.
- No commentary or notes.

---
{originalText}
---`,
    category: 'prose-repair',
    isDefault: true,
    variables: ['originalText'],
  },

  'prose-fallback': {
    id: 'default-prose-fallback',
    name: 'Default Prose Fallback',
    description: 'Fallback prompt for prose generation when main generation fails',
    version: '1.0.0',
    updatedAt: '2025-08-29',
    template: `TASK
Write a self-contained scene from these beats. Ignore strict guardrails only if needed to complete a coherent scene.

{beatsJson}

OUTPUT CONTRACT
- Length: {length || '~800-1200 words'}.
- Output only the scene prose.`,
    category: 'prose-fallback',
    isDefault: true,
    variables: ['beatsJson', 'length'],
  },

  'prose-revise-from-findings': {
    id: 'default-prose-revise-from-findings',
    name: 'Revise Prose from Skill Findings',
    description: 'Targeted revision of prose based on specific quality findings from skills analysis',
    version: '1.0.0',
    updatedAt: '2025-08-29',
    template: `TASK
Revise the draft below to address the listed findings.

CONSTRAINTS
- Preserve the original voice, pacing, narrative intent, and scene structure.
- Only change what the findings require.
- Keep names, facts, chronology, POV, and tense consistent unless a finding explicitly requires a change.

FINDINGS TO ADDRESS:
{findings}

{instruction ? \`AUTHOR INSTRUCTION: \${instruction}\` : ''}

{sceneOutline ? \`SCENE CONTEXT:\n\${sceneOutline}\` : ''}

---
ORIGINAL DRAFT:

{originalText}
---

OUTPUT CONTRACT
- Output only the revised prose.
- Do not add commentary, headings, notes, or change summaries.`,
    category: 'prose-revise-from-findings',
    isDefault: true,
    variables: ['findings', 'instruction', 'sceneOutline', 'originalText'],
  },
};
