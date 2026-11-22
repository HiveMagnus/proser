/**
 * Skills Runtime type definitions.
 *
 * Types for the skill interface, skill results, and the skill runner
 * that orchestrates skill execution on generated prose.
 *
 * @module skills/types
 */

// ---------------------------------------------------------------------------
// Skill interface
// ---------------------------------------------------------------------------

/** Severity of a skill finding */
export type FindingSeverity = 'error' | 'warning' | 'suggestion' | 'info';

/** A single finding produced by a skill */
export interface SkillFinding {
  /** Finding type (skill-specific) */
  type: string;
  /** Severity level */
  severity: FindingSeverity;
  /** Human-readable description of the finding */
  message: string;
  /** Optional text span in the prose that triggered this finding */
  span?: { start: number; end: number };
  /** Optional suggested fix or rewrite hint */
  suggestion?: string;
  /** Confidence in this finding [0, 1] */
  confidence: number;
  /** Reference data (skill-specific) */
  metadata?: Record<string, unknown>;
}

/** Input provided to every skill */
export interface SkillInput {
  /** Exact saved projection; omitted for explicitly unsaved advisory drafts. */
  documentSource?: { bookRevisionId: string; sceneRevisionId: string; contentHash: string; projection: 'final'; projectionSha256: string };
  bookId: number;
  sceneId?: number;
  /** The generated prose draft to analyze */
  prose: string;
  /** Scene outline/beats for context */
  sceneOutline?: string;
  /** Previous scene summary for continuity */
  previousSummary?: string;
  /** Character names expected in the scene */
  characterNames?: string[];
  /** Book title */
  title?: string;
  /** Book genre */
  genre?: string;
  /** Writing style (e.g., "third-person limited, past tense") */
  writingStyle?: string;
  /** Act/chapter context */
  actNumber?: number;
  chapterNumber?: number;
}

/** Result returned by a skill */
export interface SkillResult {
  /** Skill identifier */
  skillName: string;
  /** Skill version */
  version: string;
  /** Whether the skill completed successfully */
  status: 'completed' | 'error' | 'timeout';
  /** Findings from the analysis */
  findings: SkillFinding[];
  /** Execution latency in ms */
  latencyMs: number;
  /** Hash of the input for deduplication */
  inputHash?: string;
  /** Error message if status is 'error' */
  errorMessage?: string;
}

/** A registered skill implementation */
export interface Skill {
  /** Unique skill identifier (e.g., "continuity-critic") */
  readonly name: string;
  /** Semantic version */
  readonly version: string;
  /** Human-readable description */
  readonly description: string;
  /** Run the skill on the provided input */
  analyze(input: SkillInput): Promise<SkillResult>;
}

// ---------------------------------------------------------------------------
// Skill runner options
// ---------------------------------------------------------------------------

/** Options for the skill runner */
export interface SkillRunnerOptions {
  /** Skills to run (all registered if empty) */
  skillNames?: string[];
  /** Timeout per skill in ms */
  timeoutMs?: number;
  /** Minimum confidence threshold for findings */
  confidenceThreshold?: number;
}

/** Aggregated result from running multiple skills */
export interface SkillRunnerResult {
  /** Results from all executed skills */
  results: SkillResult[];
  /** Total execution time */
  totalLatencyMs: number;
  /** Number of findings across all skills */
  totalFindings: number;
  /** Summary by severity */
  severityCounts: Record<FindingSeverity, number>;
}
