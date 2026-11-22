/**
 * Voice Drift Detector Skill — detects character voice inconsistency.
 *
 * Analyzes generated prose to detect when character voices drift from
 * their established patterns. Compares dialogue and narration against
 * character profiles (codex entries) and recent scenes to flag
 * inconsistencies.
 *
 * @module skills/voice-drift-detector
 */

import { databaseService } from '@/lib/database';
import type { Prisma } from '@prisma/client';
import { defaultModelRouter } from '@/lib/ai/router';
import { InferenceTerminalError, TERMINAL_REASON_POLICIES } from '@/lib/ai/terminalReason';
import { withRetry } from '@/lib/resilience';
import logger from '@/lib/logger';

import type { Skill, SkillInput, SkillResult, SkillFinding } from '@/lib/skills/types';

// ---------------------------------------------------------------------------
// Dialogue extraction
// ---------------------------------------------------------------------------

interface DialogueLine {
  speaker: string | null;
  text: string;
  startIndex: number;
  endIndex: number;
}

/** Extract dialogue lines from prose with speaker attribution */
function extractDialogue(prose: string, characterNames: string[] = []): DialogueLine[] {
  const lines: DialogueLine[] = [];

  // Match patterns like: "text" Name said / Name said, "text"
  // Matches quoted speech with nearby speaker attribution
  const quotePattern = /[“"]([^”"]+)[”"][,.]?\s*(?:said|replied|whispered|shouted|asked|muttered|exclaimed|called|announced|declared|growled|snarled|murmured|sighed|hissed|laughed|cried|yelled|snapped|spoke)\s+([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)/g;

  let match;
  while ((match = quotePattern.exec(prose)) !== null) {
    lines.push({
      speaker: match[2],
      text: match[1],
      startIndex: match.index,
      endIndex: match.index + match[0].length,
    });
  }

  // Also match: Name said, "text"
  const preSpeakerPattern = /([A-Z][\w'-]*(?:\s+[A-Z][\w'-]*)*)\s+(?:said|replied|whispered|shouted|asked|muttered|exclaimed|called|announced|declared|growled|snarled|murmured|sighed|hissed|laughed|cried|yelled|snapped|spoke)[,:]?\s*[“"]([^”"]+)[”"][,.]?/g;

  while ((match = preSpeakerPattern.exec(prose)) !== null) {
    // Avoid duplicates from overlapping matches
    const existsOverlap = lines.some(
      (l) =>
        (match!.index >= l.startIndex && match!.index <= l.endIndex) ||
        (l.startIndex >= match!.index && l.startIndex <= match!.index + match![0].length)
    );
    if (!existsOverlap) {
      lines.push({
        speaker: match[1],
        text: match[2],
        startIndex: match.index,
        endIndex: match.index + match[0].length,
      });
    }
  }

  // Resolve contemporary action-beat and unattributed exchanges using known
  // entities plus conversational turn order.
  const allQuotes = [...prose.matchAll(/[“"]([^”"]+)[”"]/g)];
  let lastSpeaker: string | null = null;
  for (const quote of allQuotes) {
    if (lines.some((line) => quote.index! >= line.startIndex && quote.index! <= line.endIndex)) continue;
    const before = prose.slice(Math.max(0, quote.index! - 180), quote.index!);
    const after = prose.slice(quote.index! + quote[0].length, quote.index! + quote[0].length + 180);
    const nearby = characterNames.find((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(`${before} ${after}`));
    const speaker: string | null = nearby ?? lastSpeaker;
    lines.push({ speaker, text: quote[1], startIndex: quote.index!, endIndex: quote.index! + quote[0].length });
    if (speaker) lastSpeaker = speaker;
  }
  return lines.sort((a, b) => a.startIndex - b.startIndex);
}

// ---------------------------------------------------------------------------
// Heuristic voice analysis
// ---------------------------------------------------------------------------

/** Compute basic textual features for voice comparison */
interface VoiceFeatures {
  avgWordLength: number;
  sentenceLength: number;
  vocabularyRichness: number;
  formalityScore: number;
  contractionRate: number;
}

function computeVoiceFeatures(text: string): VoiceFeatures {
  const words = text
    .toLowerCase()
    .replace(/[^a-z'\s-]/g, '')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) {
    return {
      avgWordLength: 0,
      sentenceLength: 0,
      vocabularyRichness: 0,
      formalityScore: 0.5,
      contractionRate: 0,
    };
  }

  const avgWordLength = words.reduce((sum, w) => sum + w.length, 0) / words.length;
  const sentences = text.split(/[.!?]+/).filter(Boolean);
  const sentenceLength = words.length / Math.max(1, sentences.length);
  const uniqueWords = new Set(words);
  const vocabularyRichness = uniqueWords.size / words.length;

  // Formality indicators
  const contractions = words.filter((w) => w.includes("'")).length;
  const contractionRate = contractions / words.length;

  const formalWords = new Set([
    'therefore', 'however', 'moreover', 'nevertheless', 'furthermore',
    'indeed', 'consequently', 'accordingly', 'hence', 'thus',
    'shall', 'whom', 'henceforth', 'whereby',
  ]);
  const informalWords = new Set([
    'yeah', 'nah', 'gonna', 'wanna', 'gotta', 'kinda', 'sorta',
    'ain\'t', 'dunno', 'lemme', 'y\'all', 'ok', 'cool', 'hey',
  ]);

  const formalCount = words.filter((w) => formalWords.has(w)).length;
  const informalCount = words.filter((w) => informalWords.has(w)).length;
  const formalityScore = 0.5 + (formalCount - informalCount) / Math.max(1, words.length) * 10;

  return {
    avgWordLength,
    sentenceLength,
    vocabularyRichness,
    formalityScore: Math.min(1, Math.max(0, formalityScore)),
    contractionRate,
  };
}

/** Compute distance between two voice feature sets */
function voiceDistance(a: VoiceFeatures, b: VoiceFeatures): number {
  const diffs = [
    Math.abs(a.avgWordLength - b.avgWordLength) / 5,
    Math.abs(a.sentenceLength - b.sentenceLength) / 20,
    Math.abs(a.vocabularyRichness - b.vocabularyRichness),
    Math.abs(a.formalityScore - b.formalityScore),
    Math.abs(a.contractionRate - b.contractionRate) * 3,
  ];
  return diffs.reduce((sum, d) => sum + d, 0) / diffs.length;
}

// ---------------------------------------------------------------------------
// Skill implementation
// ---------------------------------------------------------------------------

export class VoiceDriftDetector implements Skill {
  readonly name = 'voice-drift-detector';
  readonly version = '1.0.0';
  readonly description = 'Detects when character voices drift from their established patterns.';

  async analyze(input: SkillInput): Promise<SkillResult> {
    const t0 = performance.now();
    const allFindings: SkillFinding[] = [];

    try {
      // 1. Extract dialogue from the prose
      const dialogueLines = extractDialogue(input.prose, input.characterNames);

      if (dialogueLines.length === 0) {
        return {
          skillName: this.name,
          version: this.version,
          status: 'completed',
          findings: [],
          latencyMs: performance.now() - t0,
        };
      }

      // 2. Load character profiles from codex
      const charProfiles = await this.loadCharacterProfiles(input.bookId, input.characterNames);

      // 3. Load recent dialogue samples from previous scenes
      const recentSamples = await this.loadRecentDialogue(input.bookId, input.sceneId);

      // 4. Group dialogue by speaker
      const bySpeaker = new Map<string, string[]>();
      for (const line of dialogueLines) {
        if (!line.speaker) continue;
        const key = line.speaker.toLowerCase();
        if (!bySpeaker.has(key)) bySpeaker.set(key, []);
        bySpeaker.get(key)!.push(line.text);
      }

      // 5. Heuristic voice analysis
      for (const [speaker, lines] of bySpeaker) {
        // Compute voice features for this scene's dialogue
        const currentVoice = computeVoiceFeatures(lines.join(' '));

        // Compare against recent dialogue
        const recentVoice = recentSamples.get(speaker);
        if (recentVoice) {
          const distance = voiceDistance(currentVoice, recentVoice);
          if (distance > 0.3) {
            allFindings.push({
              type: 'voice_drift',
              severity: 'warning',
              message: `Voice drift detected for character "${speaker}": dialogue style differs significantly from recent scenes (drift score: ${distance.toFixed(2)}).`,
              suggestion: `Review ${speaker}'s dialogue for consistency in formality, word choice, and sentence length.`,
              confidence: Math.min(0.9, 0.4 + distance),
              metadata: {
                speaker,
                driftScore: distance,
                currentFeatures: currentVoice,
                recentFeatures: recentVoice,
              },
            });
          }
        }

        // Compare against character profile personality
        const profile = charProfiles.get(speaker);
        if (profile) {
          const profileFindings = this.checkProfileConsistency(
            speaker,
            lines,
            currentVoice,
            profile
          );
          allFindings.push(...profileFindings);
        }
      }

      // 6. AI-powered voice analysis (if we have profiles and dialogue)
      if (charProfiles.size > 0 && dialogueLines.length >= 3) {
        try {
          const aiFindings = await this.runAIAnalysis(input, dialogueLines, charProfiles);
          allFindings.push(...aiFindings);
        } catch (error) {
          logger.warn(
            { error: (error as Error).message },
            'Voice drift AI analysis failed — using heuristic findings only'
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

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  private async loadCharacterProfiles(
    bookId: number,
    characterNames?: string[]
  ): Promise<Map<string, { description: string; traits: string[]; attributes: string }>> {
    const profiles = new Map<string, { description: string; traits: string[]; attributes: string }>();

    try {
      const where: Prisma.CodexEntryWhereInput = { bookId, entryType: 'character' };
      if (characterNames?.length) {
        where.entryName = { in: characterNames };
      }

      const entries = await databaseService.client.codexEntry.findMany({
        where,
        select: {
          entryName: true,
          entryDescription: true,
          attributes: true,
        },
      });

      for (const entry of entries) {
        // Parse traits from attributes (JSON or plain text)
        let traits: string[] = [];
        if (entry.attributes) {
          try {
            const parsed = JSON.parse(entry.attributes);
            if (parsed.personality_traits) traits = parsed.personality_traits;
            else if (parsed.traits) traits = parsed.traits;
          } catch {
            // Plain text attributes
          }
        }

        profiles.set(entry.entryName.toLowerCase(), {
          description: entry.entryDescription ?? '',
          traits,
          attributes: entry.attributes ?? '',
        });
      }
    } catch (error) {
      logger.warn({ error: (error as Error).message, bookId }, 'Failed to load character profiles');
    }

    return profiles;
  }

  private async loadRecentDialogue(
    bookId: number,
    currentSceneId?: number
  ): Promise<Map<string, VoiceFeatures>> {
    const voiceMap = new Map<string, VoiceFeatures>();

    try {
      // Fetch recent scenes with prose
      const scenes = await databaseService.client.scene.findMany({
        where: {
          chapter: { act: { bookId } },
          prose: { not: null },
          ...(currentSceneId ? { id: { lt: currentSceneId } } : {}),
        },
        orderBy: { id: 'desc' },
        take: 5,
        select: { prose: true },
      });

      // Extract dialogue from recent scenes and compute voice features
      const allDialogueByChar = new Map<string, string[]>();

      for (const scene of scenes) {
        if (!scene.prose) continue;
        const dialogue = extractDialogue(scene.prose);
        for (const line of dialogue) {
          if (!line.speaker) continue;
          const key = line.speaker.toLowerCase();
          if (!allDialogueByChar.has(key)) allDialogueByChar.set(key, []);
          allDialogueByChar.get(key)!.push(line.text);
        }
      }

      for (const [speaker, lines] of allDialogueByChar) {
        if (lines.length >= 2) {
          voiceMap.set(speaker, computeVoiceFeatures(lines.join(' ')));
        }
      }
    } catch (error) {
      logger.warn({ error: (error as Error).message, bookId }, 'Failed to load recent dialogue');
    }

    return voiceMap;
  }

  // -------------------------------------------------------------------------
  // Profile consistency check
  // -------------------------------------------------------------------------

  private checkProfileConsistency(
    speaker: string,
    lines: string[],
    voice: VoiceFeatures,
    profile: { description: string; traits: string[] }
  ): SkillFinding[] {
    const findings: SkillFinding[] = [];

    // Check if dialogue contradicts personality traits
    for (const trait of profile.traits) {
      const traitLower = trait.toLowerCase();

      // Simple trait contradiction checks
      if (traitLower.includes('quiet') || traitLower.includes('reserved') || traitLower.includes('taciturn')) {
        if (lines.length > 5) {
          findings.push({
            type: 'trait_contradiction',
            severity: 'suggestion',
            message: `${speaker} is described as "${trait}" but has ${lines.length} dialogue lines in this scene, which seems excessive for this personality.`,
            confidence: 0.4,
            metadata: { speaker, trait, lineCount: lines.length },
          });
        }
      }

      if (traitLower.includes('formal') || traitLower.includes('aristocratic') || traitLower.includes('refined')) {
        if (voice.contractionRate > 0.15) {
          findings.push({
            type: 'formality_mismatch',
            severity: 'suggestion',
            message: `${speaker} is described as "${trait}" but uses frequent contractions in dialogue (${(voice.contractionRate * 100).toFixed(0)}% of words).`,
            suggestion: `Consider reducing contractions in ${speaker}'s dialogue to maintain formal voice.`,
            confidence: 0.55,
            metadata: { speaker, trait, contractionRate: voice.contractionRate },
          });
        }
      }

      if (traitLower.includes('uneducated') || traitLower.includes('simple') || traitLower.includes('rural')) {
        if (voice.avgWordLength > 5.5 && voice.formalityScore > 0.6) {
          findings.push({
            type: 'formality_mismatch',
            severity: 'suggestion',
            message: `${speaker} is described as "${trait}" but uses sophisticated vocabulary in dialogue (avg word length: ${voice.avgWordLength.toFixed(1)}).`,
            confidence: 0.45,
            metadata: { speaker, trait, avgWordLength: voice.avgWordLength },
          });
        }
      }
    }

    return findings;
  }

  // -------------------------------------------------------------------------
  // AI-powered analysis
  // -------------------------------------------------------------------------

  private async runAIAnalysis(
    input: SkillInput,
    dialogueLines: DialogueLine[],
    charProfiles: Map<string, { description: string; traits: string[] }>
  ): Promise<SkillFinding[]> {
    const profileSection = Array.from(charProfiles.entries())
      .map(([name, p]) => {
        const traits = p.traits.length > 0 ? `\n  Traits: ${p.traits.join(', ')}` : '';
        return `- ${name}: ${p.description.slice(0, 200)}${traits}`;
      })
      .join('\n');

    const dialogueSection = dialogueLines
      .slice(0, 15) // Limit for prompt size
      .map((l) => `${l.speaker ?? 'Unknown'}: "${l.text}"`)
      .join('\n');

    const prompt = `You are a fiction voice consistency analyzer. Compare the character dialogue below against their established profiles and identify voice inconsistencies.

## Character Profiles:
${profileSection}

## Dialogue from Current Scene:
${dialogueSection}

## Instructions:
Identify cases where a character's dialogue doesn't match their personality, education level, speech patterns, or emotional state. Focus on:
1. Vocabulary and formality mismatches
2. Emotional tone that doesn't match the character's known state
3. Characters suddenly using speech patterns that belong to another character
4. Any character sounding generic rather than distinct

Return ONLY valid JSON:
{
  "findings": [
    {
      "type": "voice_inconsistency",
      "severity": "warning" | "suggestion",
      "character": "name",
      "message": "description",
      "suggestion": "how to improve",
      "confidence": 0.0-1.0
    }
  ]
}

If no issues found, return: {"findings": []}`;

    const provider = defaultModelRouter.choose('generic');
    const timeoutMs = Number(process.env.AI_TIMEOUT_SKILL_MS ?? '30000') || 30000;

    const response = await withRetry(
      (signal) => provider.generateText({
        prompt,
        signal,
        params: { glmThinking: true, glmPreserveThinking: false },
        terminalPolicy: TERMINAL_REASON_POLICIES.structured,
      }),
      1,
      undefined,
      { timeoutMs, jitter: true, shouldRetry: (error) => !(error instanceof InferenceTerminalError) }
    );

    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed.findings)) return [];

      return parsed.findings
        .filter(
          (f: Record<string, unknown>) =>
            typeof f?.message === 'string' &&
            typeof f?.confidence === 'number'
        )
        .map((f: Record<string, unknown>) => ({
          type: f.type ?? 'voice_inconsistency',
          severity: f.severity === 'warning' ? 'warning' : 'suggestion',
          message: f.message,
          suggestion: f.suggestion,
          confidence: Math.min(1, Math.max(0, f.confidence as number)),
          metadata: { character: f.character },
        })) as SkillFinding[];
    } catch {
      return [];
    }
  }
}
