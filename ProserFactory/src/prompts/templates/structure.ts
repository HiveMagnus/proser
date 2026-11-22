/**
 * Summary & outline prompt templates.
 * @module prompts/templates/structure
 */
import type { PromptTemplate } from '@/types';

export const structurePrompts: Record<string, PromptTemplate> = {
  summary: {
    id: 'default-summary',
    name: 'Default Summary Generator',
    description: 'Creates engaging book summaries for back covers',
    version: '1.0.0',
    updatedAt: '2025-08-29',
    template: `Write a compelling book summary for "{title}".
{tagline ? \`Book Tagline: \${tagline}\` : ''}
{archetypeDescription ? \`Archetype: \${archetypeDescription}\` : ''}
{context ? \`Additional context: \${context}\` : ''}

The summary should be 2-3 paragraphs and include:
- Main plot or premise
- Key themes
- What makes this book compelling

Write in an engaging style that would appear on a book's back cover.
Return only the summary text without any additional commentary.`,
    category: 'summary',
    isDefault: true,
    variables: ['title', 'tagline', 'archetypeDescription', 'context'],
  },

  outline: {
    id: 'default-outline',
    name: 'Default Story Outline Generator',
    description: 'Creates structured story outlines with acts and chapters',
    version: '1.0.0',
    updatedAt: '2025-08-29',
    template: `Create a detailed story outline for "{title}"
{genre ? \`Genre: \${genre}\` : ''}
{targetAudience ? \`Target Audience: \${targetAudience}\` : ''}
{summary ? \`Book Summary: \${summary}\` : ''}
{archetypeDescription ? \`Archetype: \${archetypeDescription}\` : ''}

Structure: {numberOfActs} acts, {chaptersPerAct} chapters per act

Format your response as a structured outline:

# Story Outline for "{title}"

## Act 1: [Act Title]
**Summary:** [Brief act summary]

### Chapter 1: [Chapter Title]
[Chapter summary]

### Chapter 2: [Chapter Title]
[Chapter summary]

## Act 2: [Act Title]
**Summary:** [Brief act summary]

### Chapter 1: [Chapter Title]
[Chapter summary]

### Chapter 2: [Chapter Title]
[Chapter summary]

## Act 3: [Act Title]
**Summary:** [Brief act summary]

### Chapter 1: [Chapter Title]
[Chapter summary]

### Chapter 2: [Chapter Title]
[Chapter summary]

Focus on plot progression, character development, and pacing without any additional commentary. Make each chapter summary 2-3 sentences.`,
    category: 'outline',
    isDefault: true,
    variables: ['title', 'genre', 'targetAudience', 'summary', 'archetypeDescription', 'numberOfActs', 'chaptersPerAct'],
  },

  structure: {
    id: 'default-structure',
    name: 'Default Story Structure Generator',
    description: 'Creates detailed story structures from outlines',
    version: '1.0.0',
    updatedAt: '2025-08-29',
    template: `Based on the story outline provided, create a detailed story structure for "{title}":

{outline}

Please create a structured breakdown with:
- Act divisions with clear themes and purposes
- Chapter summaries that advance the plot
- Scene suggestions for each chapter
- Character development arcs
- Pacing considerations

Only include the structure without any additional commentary.

Format your response as follows:

# Story Structure for "{title}"

## Act 1: The Bargain - [Theme/Purpose]
**Act Summary:** [2-3 sentences about this act's role]

### Chapter 1: [Title]
**Summary:** [What happens in this chapter]
**Key Scenes:**
- Scene 1: [Brief description]
- Scene 2: [Brief description]
**Character Development:** [How characters grow/change]

## Act 2: Descent into Darkness - [Theme/Purpose]
**Act Summary:** [2-3 sentences about this act's role]

### Chapter 1: [Title]
**Summary:** [What happens in this chapter]
**Key Scenes:**
- Scene 1: [Brief description]
- Scene 2: [Brief description]
**Character Development:** [How characters grow/change]

## Act 3: The Damnation - [Theme/Purpose]
**Act Summary:** [2-3 sentences about this act's role]

### Chapter 1: [Title]
**Summary:** [What happens in this chapter]
**Key Scenes:**
- Scene 1: [Brief description]
- Scene 2: [Brief description]
**Character Development:** [How characters grow/change]

## Pacing Notes
[Overall pacing strategy and key dramatic moments]`,
    category: 'structure',
    isDefault: true,
    variables: ['title', 'outline'],
  },
};

// Additional structure-related templates (not part of DEFAULT_PROMPTS keyed lookup)
export const CHAPTER_OUTLINE_TEMPLATE = `Create a chapter outline for Chapter {chapterNumber} in "{bookTitle}"

Act: {actTitle}
Act Summary: {actSummary}

Book Context:
{bookGenre ? \`Genre: \${bookGenre}\` : ''}
{bookSummary ? \`Book Summary: \${bookSummary}\` : ''}

Provide:
- Chapter title
- Chapter outline (3-4 bullet points describing what happens)

IMPORTANT: Respond with ONLY valid JSON in this exact shape and nothing else.
{
  "title": "Chapter Title",
  "outline": "• Point 1\\n• Point 2\\n• Point 3\\n• Point 4"
}`;

export const SCENE_OUTLINE_TEMPLATE = `Create a detailed outline for a single scene: Scene {sceneNumber} in Chapter {chapterNumber} of "{bookTitle}".

Chapter: {chapterTitle}
Chapter Outline: {chapterOutline}

Book Context:
{bookGenre ? \`Genre: \${bookGenre}\` : ''}
{bookSummary ? \`Book Summary: \${bookSummary}\` : ''}

Provide 6-10 numbered beats describing what happens in this specific scene
- POV: third-person limited (Elara), past tense

IMPORTANT: Respond with ONLY valid JSON in this exact shape and nothing else.
{
  "outline": "1) Beat one...\n2) Beat two...\n3) ..."
}`;

export const SCENE_SUMMARY_TEMPLATE = `Write a detailed scene summary for Scene {sceneNumber} in Chapter {chapterNumber} of "{bookTitle}".

Scene: {sceneTitle}
Scene Outline: {sceneOutline}
Chapter Outline: {chapterOutline}

Book Context:
{bookGenre ? \`Genre: \${bookGenre}\` : ''}
{bookSummary ? \`Book Summary: \${bookSummary}\` : ''}

Write a 1-2 paragraph summary describing:
- What happens in this scene
- Key character interactions
- Important plot developments
- Setting and atmosphere

Only return the summary text without any additional commentary, formatting instructions, or headings.`;

export const SHORT_SUMMARY_TEMPLATE = `Summarize the following {scope} in 1-2 sentences.
Hard cap: 280 characters total. Output only the summary text without headings or labels.
{title ? \`Title: \${title}\` : ''}

Text:
{text}

Only return the summary text without any additional commentary, formatting instructions, or headings.`;
