/**
 * Inline suggestion prompt templates.
 * @module prompts/templates/interactive
 */
import type { PromptTemplate } from '@/types';

export const interactivePrompts: Record<string, PromptTemplate> = {
  'inline-suggestion': {
    id: 'default-inline-suggestion',
    name: 'Default Inline Suggestion Generator',
    description: 'Provides contextual writing suggestions and improvements',
    version: '1.0.0',
    updatedAt: '2025-08-29',
    template: `TASK
Read the inputs and return ONLY a single JSON object. Use this exact schema:

{ "action": "continue|rewrite|expand|shorten|improve", "edit": { "type": "append|replace", "text": "string" } }

Rules:
- If action is "continue": edit.type MUST be "append" and edit.text MUST naturally continue from the selected text in the same voice.
- If action is "rewrite" | "shorten" | "expand" | "improve": edit.type MUST be "replace" and edit.text MUST be the edited prose for ONLY the selected text.
- Keep edits tightly scoped to the selection and coherent with the surrounding context.
- Never include labels, explanations, headings, or any text outside the JSON object.
- JSON must be valid: no trailing commas, double quotes for strings, and escaped quotes inside strings.
- Obey the schema exactly. Do not add extra keys.

Inputs:
Action: {action}
Selected (between <<< >>>): <<< {selectedText} >>>
Book: {bookContext}
Scene: {sceneContext}
Genre: {genre}
Target Audience: {targetAudience}
{codex ? \`Codex (characters/locations/items): \${codex}\` : ''}
{contextBefore ? \`Context before: \${contextBefore}\` : ''}
{contextAfter ? \`Context after: \${contextAfter}\` : ''}`,
    category: 'inline-suggestion',
    isDefault: true,
    variables: ['action', 'selectedText', 'bookContext', 'sceneContext', 'codex', 'contextBefore', 'contextAfter', 'genre', 'targetAudience'],
  },
};
