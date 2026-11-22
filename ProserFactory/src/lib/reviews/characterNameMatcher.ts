const HONORIFICS = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'sir', 'lady', 'lord']);
const ALIAS_KEYS = new Set(['alias', 'aliases', 'nickname', 'nicknames', 'knownas', 'aka', 'firstname']);

function words(value: string): string[] {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('en-US')
    .match(/[a-z0-9]+/g) ?? [];
}

function phrase(value: string): string {
  return words(value).join(' ');
}

function givenName(value: string): string | null {
  const parts = words(value).filter((part) => !HONORIFICS.has(part));
  return parts.find((part) => part.length >= 2) ?? null;
}

function explicitAliases(attributes: unknown): string[] {
  if (typeof attributes === 'string') {
    try { return explicitAliases(JSON.parse(attributes)); }
    catch { return []; }
  }
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return [];
  const aliases: string[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (!ALIAS_KEYS.has(phrase(key).replace(/ /g, ''))) continue;
    if (typeof value === 'string') aliases.push(value);
    if (Array.isArray(value)) aliases.push(...value.filter((item): item is string => typeof item === 'string'));
  }
  return aliases;
}

export type CharacterNameInput = { entryName: string; attributes?: unknown };

export function characterAliases(character: CharacterNameInput, allCharacters: CharacterNameInput[]): string[] {
  const canonical = phrase(character.entryName);
  const aliases = new Set<string>();
  if (canonical) aliases.add(canonical);
  for (const alias of explicitAliases(character.attributes)) {
    const normalized = phrase(alias);
    if (normalized) aliases.add(normalized);
  }
  const first = givenName(character.entryName);
  if (first && allCharacters.filter((candidate) => givenName(candidate.entryName) === first).length === 1) aliases.add(first);
  return [...aliases].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

export function findCharacterMention(character: CharacterNameInput, allCharacters: CharacterNameInput[], prose: string): { matched: boolean; alias: string | null } {
  const haystack = ` ${phrase(prose)} `;
  for (const alias of characterAliases(character, allCharacters)) {
    if (haystack.includes(` ${alias} `)) return { matched: true, alias };
  }
  return { matched: false, alias: null };
}
