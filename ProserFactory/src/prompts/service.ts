import { DEFAULT_PROMPTS, CHAPTER_OUTLINE_TEMPLATE, SCENE_OUTLINE_TEMPLATE, SCENE_SUMMARY_TEMPLATE, SHORT_SUMMARY_TEMPLATE } from './templates';
import type { PromptTemplate } from '@/types';
import { interpolatePrompt } from '@/lib/utils/promptTemplates';

export type AdditionalTemplateName = 'CHAPTER_OUTLINE_TEMPLATE' | 'SCENE_OUTLINE_TEMPLATE' | 'SCENE_SUMMARY_TEMPLATE' | 'SHORT_SUMMARY_TEMPLATE';
export type PromptVisibility = 'public' | 'user-owned' | 'internal' | 'administrative';

// Built-in prompt recipes contain system/editorial policy and are internal.
// The complete visibility vocabulary is explicit here so future persisted
// public, user-owned, or administrative templates cannot inherit access by
// accident.
export function getPromptVisibility(_key: string): PromptVisibility {
  return 'internal';
}

// Helper function to get a prompt by category (useful for factory and generation)
export function getPromptByCategory(category: PromptTemplate['category']): PromptTemplate | undefined {
  return Object.values(DEFAULT_PROMPTS).find(prompt => prompt.category === category);
}

export function listPrompts(): Array<PromptTemplate & { key: string; visibility: PromptVisibility }> {
  return Object.entries(DEFAULT_PROMPTS).map(([key, value]) => ({
    key,
    ...value,
    visibility: getPromptVisibility(key),
  }));
}

export function getPrompt(key: string): PromptTemplate | undefined {
  return DEFAULT_PROMPTS[key];
}

export function getAdditionalTemplate(name: AdditionalTemplateName): string {
  switch (name) {
    case 'CHAPTER_OUTLINE_TEMPLATE':
      return CHAPTER_OUTLINE_TEMPLATE;
    case 'SCENE_OUTLINE_TEMPLATE':
      return SCENE_OUTLINE_TEMPLATE;
    case 'SCENE_SUMMARY_TEMPLATE':
      return SCENE_SUMMARY_TEMPLATE;
    case 'SHORT_SUMMARY_TEMPLATE':
      return SHORT_SUMMARY_TEMPLATE;
    default:
      // Exhaustive check
      const _exhaustive: never = name;
      return _exhaustive;
  }
}

// Centralized prompt interpolation service
// Combines template lookup and variable interpolation in one convenient function
export function interpolatePromptByKey(
  key: string, 
  variables: Record<string, unknown>
): string {
  const template = getPrompt(key);
  if (!template) {
    throw new Error(`Prompt template not found: ${key}`);
  }
  return interpolatePrompt(template.template, variables);
}

// Centralized additional template interpolation service
export function interpolateAdditionalTemplate(
  name: AdditionalTemplateName,
  variables: Record<string, unknown>
): string {
  const template = getAdditionalTemplate(name);
  return interpolatePrompt(template, variables);
}

// Re-export the interpolation function for direct access
export { interpolatePrompt } from '@/lib/utils/promptTemplates';
