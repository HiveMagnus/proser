/**
 * Consistency Validator — checks for contradictions between new prose
 * and established narrative memory.
 *
 * Pre-generation: validates scene beats/outline against memory.
 * Post-generation: detects contradictions introduced by new prose.
 *
 * All findings are advisory (non-blocking). Results are recorded for
 * observability and skill integration.
 *
 * @module memory/validator
 */

import { CONFIG } from '@/core/config';
import logger from '@/lib/logger';
import { trace } from '@opentelemetry/api';
import * as memoryMetrics from '@/metrics/memory';

import type {
  ConsistencyFinding,
  ConsistencyResult,
} from '@/lib/memory/types';

import {
  retrieveTimelineEvents,
  retrieveCharacterStates,
  retrievePlotThreads,
} from '@/lib/memory/retrieval';

// ---------------------------------------------------------------------------
// Heuristic checks
// ---------------------------------------------------------------------------

/**
 * Check for character state contradictions in prose text.
 *
 * Compares known character states (injuries, location, possessions) against
 * mentions in the new prose text using simple heuristic matching.
 */
function checkCharacterStateContradictions(
  proseText: string,
  characterStates: Map<string, { stateKey: string; stateValue: string; sceneId: number }[]>
): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  const lower = proseText.toLowerCase();

  for (const [charName, states] of characterStates) {
    const charLower = charName.toLowerCase();
    if (!lower.includes(charLower)) continue;

    for (const state of states) {
      // Check for injury contradictions
      if (state.stateKey === 'injuries') {
        // If character is described as injured but prose implies they're fine
        const healedIndicators = ['fully recovered', 'healed completely', 'no sign of injury', 'perfectly healthy'];
        for (const indicator of healedIndicators) {
          const charProximity = findNearbyText(lower, charLower, 200);
          if (charProximity && charProximity.includes(indicator)) {
            findings.push({
              type: 'state_mismatch',
              severity: 'warning',
              message: `${charName} has recorded injury "${state.stateValue}" (scene ${state.sceneId}) but prose suggests recovery without explicit healing scene.`,
              reference: { sceneId: state.sceneId },
              confidence: 0.6,
            });
          }
        }
      }

      // Check for location contradictions
      if (state.stateKey === 'location') {
        const knownLocation = state.stateValue.toLowerCase();
        // If character is at a known location but prose puts them somewhere contradictory
        // This is a lightweight heuristic — the Continuity Critic skill does deeper checking
        const locationMentions = extractLocationMentions(lower, charLower);
        for (const mentioned of locationMentions) {
          if (
            mentioned !== knownLocation &&
            !lower.includes(`arrived at`) &&
            !lower.includes(`traveled to`) &&
            !lower.includes(`journeyed to`)
          ) {
            // Only flag if the character's last known location is very different
            if (levenshteinDistance(mentioned, knownLocation) > 5) {
              findings.push({
                type: 'state_mismatch',
                severity: 'info',
                message: `${charName} was last at "${state.stateValue}" (scene ${state.sceneId}) but appears to be at "${mentioned}" without a transition.`,
                reference: { sceneId: state.sceneId },
                confidence: 0.4,
              });
            }
          }
        }
      }
    }
  }

  return findings;
}

/**
 * Check for unresolved thread issues.
 *
 * Flags threads that are past their due horizon or have been open
 * too long without escalation.
 */
function checkThreadIssues(
  threads: { threadKey: string; status: string; dueHorizon?: string; firstSceneId?: number; lastSceneId?: number }[],
  currentActNumber?: number
): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];

  for (const thread of threads) {
    if (thread.status !== 'open' && thread.status !== 'escalated') continue;

    // Check due horizon
    if (thread.dueHorizon && currentActNumber) {
      const match = thread.dueHorizon.match(/act-?(\d+)/i);
      if (match) {
        const dueAct = parseInt(match[1], 10);
        if (currentActNumber > dueAct) {
          findings.push({
            type: 'unresolved_thread',
            severity: 'warning',
            message: `Plot thread "${thread.threadKey}" was due by act ${dueAct} but is still ${thread.status} in act ${currentActNumber}.`,
            confidence: 0.7,
          });
        }
      }

      if (thread.dueHorizon.toLowerCase() === 'climax' && currentActNumber >= 3) {
        findings.push({
          type: 'unresolved_thread',
          severity: 'info',
          message: `Plot thread "${thread.threadKey}" is due at the climax — ensure it's addressed in act ${currentActNumber}.`,
          confidence: 0.5,
        });
      }
    }
  }

  return findings;
}

/**
 * Check for character absence — characters expected in a scene
 * who aren't mentioned in the prose.
 */
function checkCharacterAbsence(
  proseText: string,
  expectedCharacters: string[],
  sceneOutline?: string
): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];
  if (!expectedCharacters.length) return findings;

  const lower = proseText.toLowerCase();
  const outlineLower = (sceneOutline ?? '').toLowerCase();

  for (const charName of expectedCharacters) {
    const charLower = charName.toLowerCase();

    // Only flag if the character is mentioned in the outline but missing from prose
    if (outlineLower.includes(charLower) && !lower.includes(charLower)) {
      findings.push({
        type: 'character_absence',
        severity: 'warning',
        message: `Character "${charName}" is mentioned in the scene outline but not present in the generated prose.`,
        confidence: 0.7,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/** Find text near a character name mention */
function findNearbyText(
  text: string,
  name: string,
  windowSize: number
): string | null {
  const idx = text.indexOf(name);
  if (idx < 0) return null;
  const start = Math.max(0, idx - windowSize);
  const end = Math.min(text.length, idx + name.length + windowSize);
  return text.slice(start, end);
}

/** Extract location-like phrases near a character mention */
function extractLocationMentions(text: string, charName: string): string[] {
  const locations: string[] = [];
  const patterns = [
    new RegExp(`${charName}\\s+(?:was|stood|sat|waited|arrived)\\s+(?:at|in|on|near|beside)\\s+(?:the\\s+)?([a-z\\s]{3,30})`, 'gi'),
    new RegExp(`(?:at|in|inside)\\s+(?:the\\s+)?([a-z\\s]{3,30})\\s*[,.]?\\s*${charName}`, 'gi'),
  ];
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(text)) !== null) {
      locations.push(m[1].trim().toLowerCase());
    }
  }
  return locations;
}

/** Simple Levenshtein distance for string comparison */
function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0
    )
  );

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[a.length][b.length];
}

// ---------------------------------------------------------------------------
// Main validation function
// ---------------------------------------------------------------------------

/**
 * Validate prose against established narrative memory.
 *
 * Runs lightweight heuristic checks for contradictions, unresolved
 * threads, and character absence. Returns findings as advisory
 * suggestions — never blocks generation.
 */
export async function validateConsistency(params: {
  bookId: number;
  sceneId: number;
  prose: string;
  sceneOutline?: string;
  characterNames?: string[];
  actNumber?: number;
}): Promise<ConsistencyResult> {
  const tracer = trace.getTracer('consistency-validator');

  return await tracer.startActiveSpan('memory.validate', async (span) => {
    const t0 = performance.now();
    const { bookId, sceneId, prose } = params;

    span.setAttributes({ bookId, sceneId });

    const emptyResult: ConsistencyResult = {
      bookId,
      sceneId,
      findings: [],
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
    };

    if (!CONFIG.RAG_MEMORY_ENABLED) {
      return emptyResult;
    }

    try {
      // Retrieve memory context
      const [, characterStates, threads] = await Promise.all([
        retrieveTimelineEvents({
          bookId,
          sceneId,
          characterNames: params.characterNames,
          maxEvents: 10,
        }),
        retrieveCharacterStates({
          bookId,
          sceneId,
          characterNames: params.characterNames,
          maxStates: 20,
        }),
        retrievePlotThreads({ bookId, maxThreads: 10 }),
      ]);

      // Convert characterStates to format needed by checker
      const stateMap = new Map<string, { stateKey: string; stateValue: string; sceneId: number }[]>();
      for (const [charName, changes] of characterStates) {
        stateMap.set(
          charName,
          changes.map((c) => ({
            stateKey: c.stateKey,
            stateValue: c.stateValue,
            sceneId: sceneId, // use current scene as reference
          }))
        );
      }

      // Run all checks
      const findings: ConsistencyFinding[] = [
        ...checkCharacterStateContradictions(prose, stateMap),
        ...checkThreadIssues(
          threads.map((t) => ({ ...t, firstSceneId: undefined, lastSceneId: undefined })),
          params.actNumber
        ),
        ...checkCharacterAbsence(prose, params.characterNames ?? [], params.sceneOutline),
      ];

      const latencyMs = performance.now() - t0;

      // Metrics
      memoryMetrics.recordValidationTime(latencyMs, { book_id: bookId });
      memoryMetrics.recordContradictions(
        findings.filter((f) => f.severity === 'error' || f.severity === 'warning').length,
        { book_id: bookId }
      );

      span.setAttributes({
        findingsCount: findings.length,
        errors: findings.filter((f) => f.severity === 'error').length,
        warnings: findings.filter((f) => f.severity === 'warning').length,
        latencyMs: Math.round(latencyMs),
      });

      if (findings.length > 0) {
        logger.info(
          {
            bookId,
            sceneId,
            findingsCount: findings.length,
            findings: findings.map((f) => ({
              type: f.type,
              severity: f.severity,
              message: f.message,
            })),
          },
          'Consistency validation found issues'
        );
      }

      return {
        bookId,
        sceneId,
        findings,
        checkedAt: new Date().toISOString(),
        latencyMs,
      };
    } catch (error) {
      span.recordException(error as Error);
      logger.warn(
        { error: (error as Error).message, bookId, sceneId },
        'Consistency validation failed — non-blocking'
      );
      return { ...emptyResult, latencyMs: performance.now() - t0 };
    } finally {
      span.end();
    }
  });
}
