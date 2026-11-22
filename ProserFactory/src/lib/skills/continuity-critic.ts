/**
 * Continuity Critic Skill — detects narrative contradictions.
 *
 * Analyzes generated prose against narrative memory (timeline events,
 * character states, plot threads) to find continuity errors. Uses
 * both heuristic checks and AI-powered analysis.
 *
 * Findings are advisory — never blocks generation.
 *
 * @module skills/continuity-critic
 */

import { defaultModelRouter } from '@/lib/ai/router';
import { InferenceTerminalError, TERMINAL_REASON_POLICIES } from '@/lib/ai/terminalReason';
import { withRetry } from '@/lib/resilience';
import { retrieveMemoryContext } from '@/lib/memory/retrieval';
import logger from '@/lib/logger';

import type { Skill, SkillInput, SkillResult, SkillFinding } from '@/lib/skills/types';

// ---------------------------------------------------------------------------
// Heuristic checks (fast, no AI call)
// ---------------------------------------------------------------------------

/** Check for temporal inconsistencies in the prose */
function checkTemporalConsistency(
  prose: string,
  events: Array<{ eventType: string; actors: string[]; summary: string }>
): SkillFinding[] {
  const findings: SkillFinding[] = [];
  const lower = prose.toLowerCase();

  // Check for characters who departed but appear again without arrival
  const departed = new Set<string>();
  const arrived = new Set<string>();

  for (const event of events) {
    if (event.eventType === 'departure') {
      for (const actor of event.actors) {
        departed.add(actor.toLowerCase());
      }
    }
    if (event.eventType === 'arrival') {
      for (const actor of event.actors) {
        arrived.add(actor.toLowerCase());
        departed.delete(actor.toLowerCase());
      }
    }
  }

  // Characters who departed but never arrived back
  for (const charName of departed) {
    if (lower.includes(charName) && !arrived.has(charName)) {
      findings.push({
        type: 'character_location',
        severity: 'warning',
        message: `Character "${charName}" previously departed the scene but appears in the current prose without an arrival event.`,
        confidence: 0.5,
        metadata: { charName },
      });
    }
  }

  // Check for dead characters appearing alive
  const deathIndicators = ['killed', 'died', 'death of', 'perished', 'slain'];
  for (const event of events) {
    if (event.eventType === 'resolution' || event.eventType === 'action') {
      const summaryLower = event.summary.toLowerCase();
      for (const indicator of deathIndicators) {
        if (summaryLower.includes(indicator)) {
          for (const actor of event.actors) {
            const actorLower = actor.toLowerCase();
            if (lower.includes(actorLower)) {
              // Character mentioned in a death event but present in current prose
              const speakingPatterns = [
                `${actorLower} said`, `${actorLower} spoke`, `${actorLower} replied`,
                `${actorLower} laughed`, `${actorLower} smiled`, `${actorLower} walked`,
              ];
              const isActive = speakingPatterns.some((p) => lower.includes(p));
              if (isActive) {
                findings.push({
                  type: 'dead_character_active',
                  severity: 'error',
                  message: `Character "${actor}" was involved in event "${event.summary}" (suggesting death/incapacitation) but is actively participating in this scene.`,
                  confidence: 0.6,
                  metadata: { charName: actor, event: event.summary },
                });
              }
            }
          }
        }
      }
    }
  }

  return findings;
}

/** Check for state contradictions using character state ledger */
function checkStateContradictions(
  prose: string,
  characterStates: Map<string, Array<{ stateKey: string; stateValue: string }>>
): SkillFinding[] {
  const findings: SkillFinding[] = [];
  const lower = prose.toLowerCase();

  for (const [charName, states] of characterStates) {
    const charLower = charName.toLowerCase();
    if (!lower.includes(charLower)) continue;

    for (const state of states) {
      // Check injury contradictions
      if (state.stateKey === 'injuries') {
        const injuryText = state.stateValue.toLowerCase();
        // Look for the character doing things that conflict with their injuries
        if (injuryText.includes('broken leg') || injuryText.includes('broken arm')) {
          const conflictingActions = ['ran', 'sprinted', 'climbed', 'fought with both hands', 'leaped'];
          for (const action of conflictingActions) {
            if (lower.includes(`${charLower} ${action}`)) {
              findings.push({
                type: 'injury_contradiction',
                severity: 'warning',
                message: `${charName} has recorded injury "${state.stateValue}" but is performing action "${action}" in the prose.`,
                suggestion: `Consider acknowledging the injury or showing it's healed.`,
                confidence: 0.65,
                metadata: { charName, injury: state.stateValue, action },
              });
            }
          }
        }
      }

      // Check possession contradictions
      if (state.stateKey === 'possessions') {
        const items = state.stateValue.toLowerCase().split(',').map((s) => s.trim());
        for (const item of items) {
          if (item.length < 3) continue;
          // If character "lost" an item but prose shows them using it
          const lostPatterns = [`lost the ${item}`, `gave away the ${item}`, `dropped the ${item}`];
          const hasLost = lostPatterns.some((p) => lower.includes(p));
          if (!hasLost) continue;
          const usedPatterns = [`${charLower} held the ${item}`, `${charLower} drew the ${item}`, `${charLower} used the ${item}`];
          if (usedPatterns.some((p) => lower.includes(p))) {
            findings.push({
              type: 'possession_contradiction',
              severity: 'warning',
              message: `${charName} appears to use "${item}" after it was lost/given away.`,
              confidence: 0.5,
              metadata: { charName, item },
            });
          }
        }
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// AI-powered deep analysis
// ---------------------------------------------------------------------------

function buildContinuityPrompt(
  prose: string,
  memoryContext: string
): string {
  return `You are a meticulous fiction continuity checker. Analyze the following scene prose against the established narrative memory and identify any contradictions or continuity errors.

## Established Narrative Memory:
${memoryContext}

## New Scene Prose:
${prose.slice(0, 5000)}

## Instructions:
Find contradictions between the new prose and established memory. Focus on:
1. Character actions that contradict their known state (injuries, location, possessions)
2. Timeline inconsistencies (events out of order, impossible timing)
3. Facts that contradict previously established facts
4. Characters acting out of their established role

Return ONLY valid JSON (no markdown, no commentary):
{
  "findings": [
    {
      "type": "contradiction" | "timeline_error" | "fact_error" | "role_violation",
      "severity": "error" | "warning",
      "message": "description of the issue",
      "suggestion": "how to fix it",
      "confidence": 0.0-1.0
    }
  ]
}

If no issues are found, return: {"findings": []}`;
}

function parseAIFindings(response: string): SkillFinding[] {
  try {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed.findings)) return [];

    return parsed.findings
      .filter(
        (f: Record<string, unknown>) =>
          typeof f?.message === 'string' &&
          typeof f?.type === 'string' &&
          typeof f?.confidence === 'number'
      )
      .map((f: Record<string, unknown>) => ({
        type: f.type,
        severity: f.severity === 'error' ? 'error' : 'warning',
        message: f.message,
        suggestion: f.suggestion,
        confidence: Math.min(1, Math.max(0, f.confidence as number)),
      })) as SkillFinding[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Skill implementation
// ---------------------------------------------------------------------------

export class ContinuityCritic implements Skill {
  readonly name = 'continuity-critic';
  readonly version = '1.0.0';
  readonly description = 'Detects narrative contradictions between generated prose and established story memory.';

  async analyze(input: SkillInput): Promise<SkillResult> {
    const t0 = performance.now();
    const allFindings: SkillFinding[] = [];

    try {
      // 1. Retrieve memory context
      const memoryCtx = await retrieveMemoryContext({
        bookId: input.bookId,
        sceneId: input.sceneId,
        characterNames: input.characterNames,
        maxEvents: 20,
        maxStates: 30,
        maxThreads: 10,
      });

      // 2. Run heuristic checks (fast)
      const temporalFindings = checkTemporalConsistency(
        input.prose,
        memoryCtx.events.map((e) => ({
          eventType: e.eventType,
          actors: e.actors,
          summary: e.summary,
        }))
      );
      allFindings.push(...temporalFindings);

      const stateFindings = checkStateContradictions(
        input.prose,
        memoryCtx.characterStates
      );
      allFindings.push(...stateFindings);

      // 3. AI-powered deep analysis (if memory is available)
      if (memoryCtx.events.length > 0 || memoryCtx.characterStates.size > 0) {
        try {
          const memoryText = formatMemoryForPrompt(memoryCtx);
          const prompt = buildContinuityPrompt(input.prose, memoryText);

          const provider = defaultModelRouter.choose('generic');
          const timeoutMs = Number(process.env.AI_TIMEOUT_SKILL_MS ?? '30000') || 30000;

          const response = await withRetry(
            (signal) => provider.generateText({
              prompt,
              signal,
              params: { glmThinking: true, glmPreserveThinking: false },
              terminalPolicy: TERMINAL_REASON_POLICIES.structured,
            }),
            1, // 1 attempt for skills (they're advisory)
            undefined,
            { timeoutMs, jitter: true, shouldRetry: (error) => !(error instanceof InferenceTerminalError) }
          );

          const aiFindings = parseAIFindings(response);
          allFindings.push(...aiFindings);
        } catch (error) {
          logger.warn(
            { error: (error as Error).message },
            'Continuity critic AI analysis failed — using heuristic findings only'
          );
        }
      }

      return {
        skillName: this.name,
        version: this.version,
        status: 'completed',
        findings: allFindings,
        latencyMs: performance.now() - t0,
      };
    } catch (error) {
      return {
        skillName: this.name,
        version: this.version,
        status: 'error',
        findings: allFindings,
        latencyMs: performance.now() - t0,
        errorMessage: (error as Error).message,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMemoryForPrompt(
  ctx: Awaited<ReturnType<typeof retrieveMemoryContext>>
): string {
  const parts: string[] = [];

  if (ctx.events.length > 0) {
    parts.push('### Recent Events');
    for (const event of ctx.events) {
      parts.push(`- [${event.eventType}] ${event.actors.join(', ')}: ${event.summary}`);
    }
  }

  if (ctx.characterStates.size > 0) {
    parts.push('\n### Character States');
    for (const [name, states] of ctx.characterStates) {
      parts.push(`${name}:`);
      for (const state of states) {
        parts.push(`  - ${state.stateKey}: ${state.stateValue}`);
      }
    }
  }

  if (ctx.activeThreads.length > 0) {
    parts.push('\n### Active Plot Threads');
    for (const thread of ctx.activeThreads) {
      parts.push(`- "${thread.threadKey}" [${thread.status}]: ${thread.description ?? 'No description'}`);
    }
  }

  return parts.join('\n');
}
