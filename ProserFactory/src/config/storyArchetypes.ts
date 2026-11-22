// Minimal backend archetype configuration for prose generation
// This mirrors the UI config but includes only the essential fields needed for prompt generation

export interface StoryArchetype {
  id: string;
  name: string;
  description: string;
}

// Key archetypes with descriptions for prompt generation
// This is a subset of the full UI config, focusing on the most commonly used archetypes
export const STORY_ARCHETYPES: StoryArchetype[] = [
  // Classic archetypes
  {
    id: "overcoming-the-monster",
    name: "Overcoming the Monster",
    description: "The protagonist sets out to defeat a great evil threatening them or their world."
  },
  {
    id: "rags-to-riches",
    name: "Rags to Riches",
    description: "An underdog rises from humble beginnings to achieve status, love, or wisdom."
  },
  {
    id: "the-quest",
    name: "The Quest",
    description: "A hero and companions journey to obtain a vital prize, facing trials along the way."
  },
  {
    id: "voyage-and-return",
    name: "Voyage and Return",
    description: "The protagonist enters an unfamiliar world, confronts dangers, and returns transformed."
  },
  {
    id: "comedy",
    name: "Comedy",
    description: "Confusion and misrecognition resolve into harmony or union; often social satire."
  },
  {
    id: "tragedy",
    name: "Tragedy",
    description: "A protagonist is undone by a fatal flaw, temptation, or fate, ending in downfall."
  },
  {
    id: "rebirth",
    name: "Rebirth",
    description: "After moral winter or captivity, the protagonist is redeemed and renewed."
  },
  
  // Popular additional archetypes
  {
    id: "underdog",
    name: "The Underdog",
    description: "An unlikely hero faces overwhelming odds and gradually turns the tide."
  },
  {
    id: "revenge",
    name: "Revenge",
    description: "The protagonist seeks retribution for a wrong, confronting moral and practical costs."
  },
  {
    id: "love-story",
    name: "Love Story",
    description: "Two characters fall in love and struggle against obstacles to be together."
  },
  {
    id: "forbidden-love",
    name: "Forbidden Love",
    description: "A romance that defies social, cultural, or moral boundaries; often bittersweet."
  },
  {
    id: "transformation",
    name: "Transformation",
    description: "Inner change into a new identity or state of being through trials or insight."
  },
  {
    id: "sacrifice",
    name: "Sacrifice",
    description: "The protagonist relinquishes something of great personal value for others or the greater good."
  },
  {
    id: "mystery",
    name: "Mystery",
    description: "Investigation uncovers hidden truths; the engine is curiosity and deduction."
  },
  {
    id: "discovery",
    name: "Discovery",
    description: "A revelation about self, others, or the world reorients the protagonist and stakes."
  },
  {
    id: "rise-and-fall",
    name: "Rise and Fall",
    description: "Ambition leads to ascent and eventual decline, exposing costs of power."
  },
  
  // Popular modern/trend archetypes
  {
    id: "fated-mates",
    name: "Fated Mates",
    description: "Predestined lovers bound by magic or cosmic law; resisting the bond raises the stakes."
  },
  {
    id: "monster-paramour",
    name: "Monster Paramour",
    description: "A human (or human-adjacent) falls for a nonhuman/monster, exploring otherness, power, and consent."
  },
  {
    id: "villain-romance",
    name: "Loving the Villain",
    description: "Romance with the antagonist or an unapologetic antihero; danger and allure collide."
  },
  {
    id: "underworld-romance",
    name: "Underworld / Mafia Romance",
    description: "Love amid criminal power structures—oaths, vendettas, and morally gray bargains."
  },
  {
    id: "dark-academia-romance",
    name: "Dark Academia Romance",
    description: "Secret societies, elite schools, and forbidden study partners wrapped in gothic mood."
  },
  {
    id: "gothic-retelling",
    name: "Gothic Retelling",
    description: "A darker spin on myths/fairytales (e.g., Beauty & the Beast, Hades & Persephone) with intense romance."
  },
  {
    id: "court-intrigue-romantasy",
    name: "Court Intrigue Romantasy",
    description: "Fae/dragon courts, political gambits, and high-stakes relationships tied to war and destiny."
  },
  {
    id: "why-choose-poly-bond",
    name: "Why‑Choose / Poly Bond",
    description: "Protagonist forms multiple consensual bonds; found‑family intimacy with shifting loyalties."
  },
  {
    id: "cursed-bond",
    name: "Cursed Bond",
    description: "A magical curse or blood‑oath forces proximity or dependence that slowly becomes love."
  },
  {
    id: "horromance",
    name: "Horromance (Horror + Romance)",
    description: "Love entwined with supernatural dread—ghosts, body horror, or killers alongside desire."
  },
  {
    id: "grimdark-power-spiral",
    name: "Grimdark Power Spiral",
    description: "An antihero ascends through violence and intrigue; romance (if any) accelerates corruption."
  },
  {
    id: "eldritch-pact",
    name: "Eldritch Pact",
    description: "A bargain with a cosmic entity grants power or love at the cost of sanity and self."
  }
];

/**
 * Find archetype by ID for prompt generation
 */
export function findArchetypeById(id?: string | null): StoryArchetype | undefined {
  if (!id) return undefined;
  return STORY_ARCHETYPES.find(a => a.id === id);
}

/**
 * Get archetype description for prompt generation
 */
export function getArchetypeDescription(id?: string | null): string | undefined {
  const archetype = findArchetypeById(id);
  return archetype?.description;
}
