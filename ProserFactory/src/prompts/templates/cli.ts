/**
 * CLI-specific prompt templates.
 * @module prompts/templates/cli
 */
import type { PromptTemplate } from '@/types';

export const cliPrompts: Record<string, PromptTemplate> = {
  'prompt-parse': {
    id: 'default-prompt-parse',
    name: 'Freeform Prompt Parser',
    description: 'Extracts structured book metadata (genre, setting, themes, character seeds) from a freeform user prompt',
    version: '1.0.0',
    updatedAt: '2026-02-12',
    template: `You are a book-planning assistant. The user described a book idea in natural language. Extract structured metadata from their description.

User prompt:
{userPrompt}

Respond with ONLY valid JSON in this exact schema (no markdown, no code fences, no commentary):

{
  "title": "string — suggested working title, or null if unclear",
  "genre": "string — primary genre (Fantasy, Sci-Fi, Romance, Thriller, Literary Fiction, etc.)",
  "setting": "string — time period and location, or null if unspecified",
  "themes": ["string — 1-5 major themes"],
  "tone": "string — overall tone (dark, humorous, epic, intimate, etc.)",
  "characterSeeds": [
    {
      "name": "string or null",
      "role": "protagonist | antagonist | supporting",
      "briefDescription": "string — 1-2 sentences"
    }
  ],
  "premise": "string — 2-3 sentence distilled premise",
  "targetAudience": "string — e.g., Young Adult, Adult, Middle Grade"
}

Rules:
- Infer plausible defaults when the user is vague (e.g., setting: "unspecified contemporary" if no setting mentioned).
- characterSeeds may be empty if no characters described.
- All string fields must be non-empty strings or null where noted.`,
    category: 'cli',
    isDefault: true,
    variables: ['userPrompt'],
  },
};
