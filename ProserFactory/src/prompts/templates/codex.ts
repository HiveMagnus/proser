/**
 * Character, location, and item (codex entity) prompt templates.
 * @module prompts/templates/codex
 */
import type { PromptTemplate } from '@/types';

export const codexPrompts: Record<string, PromptTemplate> = {
  character: {
    id: 'default-character',
    name: 'Default Character Generator',
    description: 'Creates detailed character profiles',
    version: '1.0.0',
    updatedAt: '2025-08-29',
    template: `Create a detailed character for the book "{title || 'Untitled'}"
{genre ? \`Genre: \${genre}\` : ''}
{summary ? \`Book Summary: \${summary}\` : ''}
{outline ? \`Story Outline:\n\n\${outline}\` : ''}
{archetypeDescription ? \`Story Archetype (tone/shape): \${archetypeDescription}\` : ''}
{prompt ? \`Additional requirements: \${prompt}\` : ''}

Use these existing characters from the Codex to avoid redundancy and ensure canon consistency:
{codexCharacters ? \`Other Characters (from Codex):\n\n\${codexCharacters}\` : ''}

Design constraints:
- Make this new character clearly distinct from all listed characters (archetype, goals, flaws, voice, and background should not substantially overlap).
- If there is no clear hero/protagonist OR no primary villain/antagonist among the existing characters, make this character fill the missing role. Otherwise, choose a complementary supporting role that adds contrast.

Format your response as a character profile using the following structure:

# Character Name: [Name]

**Age:** [Age]
**Occupation:** [Job/Role]

## Description
[Brief character description]

## Background
[Character's background story]

## Appearance
[Physical description]

## Personality Traits
- [Trait 1]
- [Trait 2] 
- [Trait 3]

## Motivations
- [Motivation 1]
- [Motivation 2]

## Relationships
- **[Character Name]:** [Relationship description]

Focus only on the character details without any additional commentary.`,
    category: 'character',
    isDefault: true,
    variables: ['title', 'genre', 'summary', 'outline', 'archetypeDescription', 'prompt', 'codexCharacters'],
  },

  location: {
    id: 'default-location',
    name: 'Default Location Generator',
    description: 'Creates detailed location profiles for worldbuilding',
    version: '1.0.0',
    updatedAt: '2025-08-29',
    template: `Create a detailed location for the book "{title || 'Untitled'}"
{genre ? \`Genre: \${genre}\` : ''}
{summary ? \`Book Summary: \${summary}\` : ''}
{outline ? \`Story Outline:\n\n\${outline}\` : ''}
{archetypeDescription ? \`Story Archetype (tone/shape): \${archetypeDescription}\` : ''}
{prompt ? \`Additional requirements: \${prompt}\` : ''}

Format your response as a location profile using the following structure:

# Location Name: [Name]

**Type:** [Settlement, Natural Feature, Building, etc.]
**Geography:** [Physical description and terrain]

## Description
[Detailed description of the location]

## Climate & Environment
[Weather patterns, seasons, natural conditions]

## Culture & Society
[If inhabited - social structure, customs, way of life]

## Notable Features
- [Feature 1: Description]
- [Feature 2: Description]
- [Feature 3: Description]

## Inhabitants
- [Group/Character 1: Role/relationship]
- [Group/Character 2: Role/relationship]

## History & Significance
[Background and importance to the story]

Focus only on the location details without any additional commentary.`,
    category: 'location',
    isDefault: true,
    variables: ['title', 'genre', 'summary', 'outline', 'archetypeDescription', 'prompt'],
  },

  item: {
    id: 'default-item',
    name: 'Default Item Generator',
    description: 'Creates detailed item profiles for story elements',
    version: '1.0.0',
    updatedAt: '2025-08-29',
    template: `Create a detailed item for the book "{title || 'Untitled'}"
{genre ? \`Genre: \${genre}\` : ''}
{summary ? \`Book Summary: \${summary}\` : ''}
{outline ? \`Story Outline:\n\n\${outline}\` : ''}
{archetypeDescription ? \`Story Archetype (tone/shape): \${archetypeDescription}\` : ''}
{prompt ? \`Additional requirements: \${prompt}\` : ''}

Format your response as an item profile using the following structure:

# Item Name: [Name]

**Type:** [Weapon, Tool, Artifact, Document, etc.]

## Description
[Detailed physical description]

## Properties & Abilities
- [Property 1: Description]
- [Property 2: Description]
- [Property 3: Description]

## History & Origin
[How it was created, previous owners, significant events]

## Significance
[Why this item is important to the story]

## Current Location
[Where the item currently resides]

## Related Characters
- **[Character Name]:** [Relationship to item]

Focus only on the item details without any additional commentary.`,
    category: 'item',
    isDefault: true,
    variables: ['title', 'genre', 'summary', 'outline', 'archetypeDescription', 'prompt'],
  },

  faction: {
    id: 'default-faction',
    name: 'Default Faction Generator',
    description: 'Creates detailed faction profiles (guilds, houses, orders, organisations)',
    version: '1.0.0',
    updatedAt: '2026-02-10',
    template: `Create a detailed faction / organisation for the book "{title || 'Untitled'}"
{genre ? \`Genre: \${genre}\` : ''}
{summary ? \`Book Summary: \${summary}\` : ''}
{outline ? \`Story Outline:\n\n\${outline}\` : ''}
{archetypeDescription ? \`Story Archetype (tone/shape): \${archetypeDescription}\` : ''}
{prompt ? \`Additional requirements: \${prompt}\` : ''}

Format your response as a faction profile using the following structure:

# Faction Name: [Name]

**Type:** [Guild, House, Order, Organisation, etc.]
**Alignment:** [General moral/political alignment]

## Description
[Detailed description of the faction]

## Goals & Motivations
- [Goal 1]
- [Goal 2]

## Structure & Hierarchy
[Leadership, ranks, decision-making]

## Resources & Assets
- [Resource 1]
- [Resource 2]

## Key Members
- **[Name]:** [Role and significance]

## Relationships with Other Factions
- **[Faction/Group]:** [Nature of relationship]

## History & Origin
[How the faction formed, pivotal events]

Focus only on the faction details without any additional commentary.`,
    category: 'faction',
    isDefault: true,
    variables: ['title', 'genre', 'summary', 'outline', 'archetypeDescription', 'prompt'],
  },

  event: {
    id: 'default-event',
    name: 'Default Event Generator',
    description: 'Creates detailed historical or story event entries',
    version: '1.0.0',
    updatedAt: '2026-02-10',
    template: `Create a detailed event for the book "{title || 'Untitled'}"
{genre ? \`Genre: \${genre}\` : ''}
{summary ? \`Book Summary: \${summary}\` : ''}
{outline ? \`Story Outline:\n\n\${outline}\` : ''}
{archetypeDescription ? \`Story Archetype (tone/shape): \${archetypeDescription}\` : ''}
{prompt ? \`Additional requirements: \${prompt}\` : ''}

Format your response as an event profile using the following structure:

# Event Name: [Name]

**Type:** [Battle, Treaty, Discovery, Natural Disaster, etc.]
**When:** [Time period or relative timing in the story]

## Description
[Detailed account of the event]

## Causes
- [Cause 1]
- [Cause 2]

## Key Participants
- **[Name/Group]:** [Role in the event]

## Consequences
- [Short-term consequence 1]
- [Long-term consequence 2]

## Significance to the Story
[Why this event matters for the narrative]

Focus only on the event details without any additional commentary.`,
    category: 'event',
    isDefault: true,
    variables: ['title', 'genre', 'summary', 'outline', 'archetypeDescription', 'prompt'],
  },

  rule: {
    id: 'default-rule',
    name: 'Default Rule Generator',
    description: 'Creates world rules: magic systems, laws, physics, customs',
    version: '1.0.0',
    updatedAt: '2026-02-10',
    template: `Create a detailed rule or system for the book "{title || 'Untitled'}"
{genre ? \`Genre: \${genre}\` : ''}
{summary ? \`Book Summary: \${summary}\` : ''}
{outline ? \`Story Outline:\n\n\${outline}\` : ''}
{archetypeDescription ? \`Story Archetype (tone/shape): \${archetypeDescription}\` : ''}
{prompt ? \`Additional requirements: \${prompt}\` : ''}

Format your response as a rule/system profile using the following structure:

# Rule: [Name]

**Type:** [Magic System, Law, Social Custom, Physical Law, etc.]
**Scope:** [Universal, Regional, Cultural, etc.]

## Description
[Detailed explanation of the rule or system]

## Mechanics / How It Works
- [Mechanic 1]
- [Mechanic 2]
- [Mechanic 3]

## Limitations & Costs
- [Limitation 1]
- [Limitation 2]

## Exceptions
- [Exception or edge case 1]

## Consequences of Breaking / Violating
[What happens when this rule is broken]

## Story Implications
[How this rule affects plot, character decisions, and tension]

Focus only on the rule details without any additional commentary.`,
    category: 'rule',
    isDefault: true,
    variables: ['title', 'genre', 'summary', 'outline', 'archetypeDescription', 'prompt'],
  },

  culture: {
    id: 'default-culture',
    name: 'Default Culture Generator',
    description: 'Creates detailed cultural profiles for worldbuilding',
    version: '1.0.0',
    updatedAt: '2026-02-10',
    template: `Create a detailed culture for the book "{title || 'Untitled'}"
{genre ? \`Genre: \${genre}\` : ''}
{summary ? \`Book Summary: \${summary}\` : ''}
{outline ? \`Story Outline:\n\n\${outline}\` : ''}
{archetypeDescription ? \`Story Archetype (tone/shape): \${archetypeDescription}\` : ''}
{prompt ? \`Additional requirements: \${prompt}\` : ''}

Format your response as a culture profile using the following structure:

# Culture: [Name]

**Region:** [Where this culture is found]
**Population:** [Rough scale or composition]

## Description
[Overview of the culture]

## Values & Beliefs
- [Core value 1]
- [Core value 2]

## Social Structure
[Classes, castes, family structure, governance]

## Customs & Traditions
- [Custom 1: Description]
- [Custom 2: Description]

## Language & Communication
[Distinct speech patterns, languages, symbols]

## Art, Music & Literature
[Cultural expressions]

## Relationship with Other Cultures
- **[Culture/Group]:** [Nature of relationship]

## Story Relevance
[How this culture shapes characters and plot]

Focus only on the culture details without any additional commentary.`,
    category: 'culture',
    isDefault: true,
    variables: ['title', 'genre', 'summary', 'outline', 'archetypeDescription', 'prompt'],
  },

  relationship: {
    id: 'default-relationship',
    name: 'Default Relationship Generator',
    description: 'Creates detailed relationship profiles between characters or entities',
    version: '1.0.0',
    updatedAt: '2026-02-10',
    template: `Create a detailed relationship entry for the book "{title || 'Untitled'}"
{genre ? \`Genre: \${genre}\` : ''}
{summary ? \`Book Summary: \${summary}\` : ''}
{outline ? \`Story Outline:\n\n\${outline}\` : ''}
{archetypeDescription ? \`Story Archetype (tone/shape): \${archetypeDescription}\` : ''}
{prompt ? \`Additional requirements: \${prompt}\` : ''}

Format your response as a relationship profile using the following structure:

# Relationship: [Entity A] ↔ [Entity B]

**Type:** [Romantic, Rivalry, Mentor-Student, Alliance, Family, etc.]
**Status:** [Current state — Active, Strained, Broken, Evolving, etc.]

## Description
[Overview of the relationship dynamic]

## History
[How the relationship formed, key moments]

## Current Dynamic
[Power balance, emotional tone, mutual perceptions]

## Points of Tension
- [Tension 1]
- [Tension 2]

## Points of Connection
- [Bond 1]
- [Bond 2]

## Projected Arc
[How this relationship is likely to evolve]

## Story Significance
[Why this relationship matters for the narrative]

Focus only on the relationship details without any additional commentary.`,
    category: 'relationship',
    isDefault: true,
    variables: ['title', 'genre', 'summary', 'outline', 'archetypeDescription', 'prompt'],
  },

  'codex-seed-from-prompt': {
    id: 'default-codex-seed-from-prompt',
    name: 'Codex Seed from Prompt',
    description: 'Generates initial codex entries (characters, locations, items) from a parsed book prompt',
    version: '1.0.0',
    updatedAt: '2026-02-12',
    template: `You are a worldbuilding assistant. Based on the book metadata below, generate initial codex entries to seed the knowledge base.

Title: {title}
{genre ? \`Genre: \${genre}\` : ''}
{premise ? \`Premise: \${premise}\` : ''}
{setting ? \`Setting: \${setting}\` : ''}
{themes ? \`Themes: \${themes}\` : ''}
{tone ? \`Tone: \${tone}\` : ''}
{characterSeeds ? \`Character seeds:\n\${characterSeeds}\` : ''}

Generate a JSON object with arrays for each codex category. Include only categories that are relevant.

{
  "characters": [
    {
      "name": "string",
      "role": "protagonist | antagonist | supporting",
      "description": "string — 2-3 sentences covering personality, goals, and key traits"
    }
  ],
  "locations": [
    {
      "name": "string",
      "description": "string — 2-3 sentences covering atmosphere, significance, and key details"
    }
  ],
  "items": [
    {
      "name": "string",
      "description": "string — significance and any special properties"
    }
  ]
}

Rules:
- Return ONLY valid JSON. No markdown, no code fences, no commentary.
- Characters array should include at least a protagonist. Expand character seeds into fuller descriptions.
- Locations should include 2-4 key settings. Items are optional (include only if relevant to the story).
- Do not invent characters that contradict the provided seeds.`,
    category: 'codex',
    isDefault: true,
    variables: ['title', 'genre', 'premise', 'setting', 'themes', 'tone', 'characterSeeds'],
  },
};
