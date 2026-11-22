import logger from '../lib/logger';

// Default backend system prompt, tuned for GLM-style chat + tool use.
const DEFAULT_SYSTEM_PROMPT = `You are Proser, an expert fiction-writing and story-analysis assistant.

Core behavior:
- Follow the system message, then the developer/user instructions, then the prompt content.
- Use hidden reasoning privately; never reveal chain-of-thought or internal analysis unless a visible scratchpad is explicitly requested.
- Match the user's language and keep the answer directly useful.
- Be accurate about uncertainty. If required information is missing, say so instead of inventing facts.

Output discipline:
- When asked for prose, output only the prose unless the prompt explicitly requests something else.
- When asked for JSON, return valid JSON only, with no markdown fences, labels, or commentary.
- Obey schemas exactly: required keys must be present, types must match, and extra wrapper text is not allowed.

Tool behavior:
- If tools are available and needed for correctness, call the appropriate tool instead of guessing.
- Never fabricate tool results, citations, memory lookups, calculations, or deterministic checks.
- Tool arguments must be valid JSON and strictly match the provided schema.

Writing behavior:
- Preserve requested POV, tense, continuity, and named facts.
- Avoid meta-commentary, outlines, plans, or placeholder text in final creative output.`;

// Optional: JSON from env to override per model. Shape:
// {
//   "overrides": [
//     { "match": "huihui_ai/magistral-abliterated:*", "prompt": "..." },
//     { "match": "llama3*", "prompt": "..." }
//   ],
//   "default": "..." // optional
// }
export type Override = { match: string; prompt: string };
export interface SystemPromptConfig { default?: string; overrides?: Override[] }

function readConfigFromEnv(): SystemPromptConfig | undefined {
  const raw = process.env.AI_SYSTEM_PROMPTS;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as SystemPromptConfig;
    return parsed;
  } catch (err) {
    logger.warn({ err, raw: (raw as string)?.slice?.(0, 80) }, 'Failed to parse AI_SYSTEM_PROMPTS; using defaults');
    return undefined;
  }
}

function globToRegExp(glob: string): RegExp {
  // Escape regex special chars except '*', then convert '*' -> '.*'
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function getSystemPrompt(model?: string): string {
  const cfg = readConfigFromEnv();
  const base = (cfg?.default && cfg.default.trim().length > 0) ? cfg!.default! : DEFAULT_SYSTEM_PROMPT;
  if (!model) return base;
  const overrides = cfg?.overrides || [];
  for (const ov of overrides) {
    try {
      if (globToRegExp(ov.match).test(model)) {
        return ov.prompt;
      }
    } catch { /* ignore bad patterns */ }
  }
  return base;
}

// Return plain system prompt text for use as a chat {role:"system"} message.
// Legacy Magistral-style wrapping removed — the active OpenAI-compatible backend handles formatting.
export function buildSystemPrefix(model?: string): string {
  return getSystemPrompt(model);
}

export const __defaults = { DEFAULT_SYSTEM_PROMPT };
