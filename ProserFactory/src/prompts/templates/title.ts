/**
 * Title & tagline prompt templates.
 * @module prompts/templates/title
 */
import type { PromptTemplate } from '@/types';

export const titlePrompts: Record<string, PromptTemplate> = {
  title: {
    id: 'default-title',
    name: 'Default Title Generator',
    description: 'Generates creative book titles based on genre, audience, and summary',
    version: '1.0.0',
    updatedAt: '2025-08-29',
    template: `Generate 5 creative and engaging book titles based on the following context:
{genre ? \`Genre: \${genre}\` : ''}
{targetAudience ? \`Target Audience: \${targetAudience}\` : ''}
{summary ? \`Book Summary: \${summary}\` : ''}

Return only the titles, one per line, without numbering or additional text.`,
    category: 'title',
    isDefault: true,
    variables: ['genre', 'targetAudience', 'summary'],
  },

  tagline: {
    id: 'default-tagline',
    name: 'Default Tagline Generator',
    description: 'Creates compelling taglines for book covers',
    version: '1.0.0',
    updatedAt: '2025-08-29',
    template: `Generate 5 compelling taglines for the book "{title}".
{context ? \`Additional context: \${context}\` : ''}

Create short, punchy taglines (1-2 sentences maximum) that:
- Capture the essence of the book
- Create intrigue and interest
- Would work well on a book cover
- Are memorable and engaging

Keep each tagline under 25 words.
Return only the taglines, one per line, without numbering or additional text.`,
    category: 'tagline',
    isDefault: true,
    variables: ['title', 'context'],
  },
};
