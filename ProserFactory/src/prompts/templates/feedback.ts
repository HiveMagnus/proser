/**
 * Feedback prompt templates (general, summary, and codex).
 * @module prompts/templates/feedback
 */
import type { PromptTemplate } from '@/types';

export const feedbackPrompts: Record<string, PromptTemplate> = {
  feedback: {
    id: 'default-feedback',
    name: 'Default AI Feedback Generator',
    description: 'Provides comprehensive analysis and feedback on story elements in JSON format',
    version: '1.0.0',
    updatedAt: '2025-08-29',
    template: `As an expert writing coach and editor, provide detailed feedback analysis for this {contentType}. Analyze the content for consistency, tone, plot holes, character development, and pacing.

Project Context (use to tailor scoring):
{title ? \`Title: \${title}\` : ''}
{genre ? \`Genre: \${genre}\` : ''}
{targetAudience ? \`Target Audience: \${targetAudience}\` : ''}

{contextInfo}

Content to Analyze ({contentType}):
{content}

Scoring Rules (you MUST compute real values):
- All scores are integers 1–10 (10 = excellent).
- You must derive each score from the provided content; do NOT copy any example values below.
- Compute overallScore = round(0.25*consistency.score + 0.15*tone.score + 0.25*plotHoles.score + 0.20*characterDevelopment.score + 0.15*pacing.score), then clamp 1–10.
- Replace every placeholder in the example JSON with your computed values. Do not return strings like "<placeholder>".

IMPORTANT: You must respond with ONLY valid JSON in the exact format below. Do not include any markdown formatting, explanations, or additional text.

{
  "overallScore": 8,
  "consistency": {
    "score": 7,
    "issues": ["Brief description of consistency issues found"],
    "suggestions": ["Specific suggestion for improvement"]
  },
  "tone": {
    "score": 8,
    "analysis": "Brief analysis of tone effectiveness",
    "suggestions": ["Suggestion for tone improvement"]
  },
  "plotHoles": {
    "score": 9,
    "issues": ["Any plot inconsistencies or holes identified"],
    "suggestions": ["How to address plot issues"]
  },
  "characterDevelopment": {
    "score": 7,
    "issues": ["Character development concerns"],
    "suggestions": ["Ways to improve character development"]
  },
  "pacing": {
    "score": 8,
    "analysis": "Brief analysis of pacing effectiveness",
    "suggestions": ["Pacing improvement suggestions"]
  },
  "summary": "Overall assessment of the content's strengths and areas for improvement",
  "recommendations": ["Top priority recommendation", "Second priority recommendation", "Third priority recommendation"]
}

Focus on providing practical, actionable feedback. Use scores from 1-10 where 10 is excellent. Return ONLY the JSON object above with your analysis.`,
    category: 'feedback',
    isDefault: true,
    variables: ['contentType', 'contextInfo', 'content', 'genre', 'targetAudience', 'title'],
  },

  'feedback-summary': {
    id: 'feedback-summary-default',
    name: 'Book Summary Feedback',
    description: 'Evaluates a book summary for hook, clarity, market fit, and reader appeal. Returns JSON.',
    version: '1.0.0',
    updatedAt: '2025-08-29',
    template: `You are a professional acquisitions editor evaluating a BOOK SUMMARY for marketability and clarity.

Project Context (if provided):
{title ? \`Title: \${title}\` : ''}
{genre ? \`Genre: \${genre}\` : ''}
{targetAudience ? \`Target Audience: \${targetAudience}\` : ''}

{contextInfo}

Book Summary to evaluate:
{content}

Scoring Rules (you MUST compute real values):
- All scores are integers 1-10 (10 = excellent).
- Compute overallScore = round(0.25*hook.score + 0.20*clarity.score + 0.20*marketFit.score + 0.15*stakes.score + 0.10*toneAlignment.score + 0.10*uniqueness.score), then clamp 1–10.
- length.words must be your approximate word count of the provided summary; set length.verdict to "short" (<120), "ok" (120–200), or "long" (>200).
- suggestedTaglines: provide 3-5 concise, marketable options, not placeholders.
- revisedSummary: rewrite in 120-160 words; do not copy input verbatim.
- Do NOT copy any numbers or example text from the schema below—replace with your computed values only.

IMPORTANT: Respond with ONLY valid JSON in this exact shape and nothing else.
{
  "overallScore": 8,
  "hook": { "score": 7, "comments": "How strong/compelling is the hook?", "suggestions": ["Make the inciting premise explicit in the first sentence."] },
  "clarity": { "score": 8, "issues": ["Ambiguous antagonist motivation"], "suggestions": ["State the main conflict in one clause."] },
  "marketFit": { "score": 7, "genreAlignment": "Solid {genre ? \`Genre: \${genre}\` : ''} alignment", "audience": "{targetAudience ? \`Audience: \${targetAudience}\` : ''} {genre ? \`Genre: \${genre}\` : ''} readers" },
  "stakes": { "score": 7, "clarity": "Stakes are present but can be sharper.", "suggestions": ["Quantify the cost of failure."] },
  "protagonist": { "score": 8, "goal": "Clear immediate and story-long goals", "conflict": "External authority + internal guilt", "arcPotential": "High" },
  "spoilers": { "risk": "medium", "notes": ["Avoid late-book twist reveals."] },
  "length": { "words": 180, "verdict": "ok" },
  "toneAlignment": { "score": 8, "analysis": "Tone matches genre expectations." },
  "uniqueness": { "score": 7, "notes": ["Differentiate magic cost from comps."] },
  "topIssues": ["Vague antagonist detail", "Unclear ultimate stakes"],
  "recommendations": ["Lead with the hook in line 1", "Name the antagonist force", "Clarify consequences if MC fails"],
  "suggestedTaglines": ["A sample sharp, marketable tagline."],
  "revisedSummary": "Rewrite the summary in 120-160 words maximizing hook, clarity, and market appeal."
}

Scoring is 1-10 where 10 is excellent. Keep concise but concrete.`,
    category: 'feedback-summary',
    isDefault: true,
    variables: ['contextInfo', 'content', 'title', 'genre', 'targetAudience'],
  },

  'feedback-codex': {
    id: 'feedback-codex-default',
    name: 'Codex Entries Feedback',
    description: 'Analyzes characters, locations, and items for clarity, consistency, and story utility. Returns JSON.',
    version: '1.0.0',
    updatedAt: '2025-08-29',
    template: `You are a worldbuilding editor reviewing CODEX ENTRIES (characters, locations, items) for coherence and usefulness to the story.

Project Context (if provided):
{title ? \`Title: \${title}\` : ''}
{genre ? \`Genre: \${genre}\` : ''}
{targetAudience ? \`Target Audience: \${targetAudience}\` : ''}
{summary ? \`Story Summary: \${summary}\` : ''}

{contextInfo}

Codex content to evaluate (markdown list of entries):
{content}

Scoring Rules (you MUST compute real values):
- For each entry, provide integer scores 1-10 for clarity, originality, and storyRelevance based on the provided text.
- Omit type sections that do not apply (e.g., no "location" object for characters).
- Compute overall.consistencyScore as: round( average of all entry scores.storyRelevance and scores.clarity / 2 ) minus 1 per listed conflict (max 3), minus 1 if gaps.length > 2; clamp 1–10.
- Do NOT include placeholders like "<Entry Name>"—replace with actual names from the codex. Replace every example value with your computed value.

IMPORTANT: Respond with ONLY valid JSON in this exact shape and nothing else.
{
  "overall": {
    "consistencyScore": 8,
    "conflicts": ["Elyria is listed as both orphan and royal bloodline"],
    "redundancy": ["Two similar shadow daggers"],
    "gaps": ["No description of city governance"],
    "worldRules": { "clarity": 7, "notes": ["Magic costs are implied but not explicit."] }
  },
  "entries": [
    {
      "name": "<Entry Name>",
      "type": "character|location|item",
      "summary": "One-sentence overview",
      "scores": { "clarity": 8, "originality": 7, "storyRelevance": 8 },
      "character": { "motivation": "", "arc": "", "relationships": ["Name: relation"] },
      "location": { "sensoryDetail": 7, "culture": "", "plotUse": "" },
      "item": { "rules": "", "limitations": "", "plotHooks": [""] },
      "issues": [""],
      "suggestions": [""]
    }
  ],
  "recommendations": ["Define world rules", "Merge redundant items", "Clarify political structure"]
}

Use type-appropriate fields (character/location/item) and omit irrelevant ones. Keep names identical to the codex where possible.`,
    category: 'feedback-codex',
    isDefault: true,
    variables: ['contextInfo', 'content', 'title', 'genre', 'targetAudience', 'summary'],
  },
};
