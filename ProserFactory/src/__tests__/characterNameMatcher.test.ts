import { characterAliases, findCharacterMention } from '../lib/reviews/characterNameMatcher';

describe('character name matching', () => {
  const characters = [
    { entryName: 'Mira Vale' },
    { entryName: 'Kael Veyr', attributes: { aliases: ['The Ash Prince'] } },
    { entryName: 'Seraphine Holt' },
  ];

  it('matches canonical names, unique given names, possessives, and explicit aliases', () => {
    expect(findCharacterMention(characters[0], characters, 'Mira crossed the threshold.').matched).toBe(true);
    expect(findCharacterMention(characters[1], characters, "Kael's smile vanished.")).toMatchObject({ matched: true, alias: 'kael' });
    expect(findCharacterMention(characters[1], characters, 'The Ash Prince answered.').matched).toBe(true);
    expect(characterAliases(characters[1], characters)).toEqual(['the ash prince', 'kael veyr', 'kael']);
  });

  it('reads aliases from the JSON string format persisted by the codex model', () => {
    const persisted = [
      { entryName: 'Mira Vale', attributes: null },
      { entryName: 'Kael Veyr', attributes: JSON.stringify({ aliases: ['The Ash Prince'] }) },
    ];
    expect(findCharacterMention(persisted[1], persisted, 'The Ash Prince answered.')).toMatchObject({ matched: true, alias: 'the ash prince' });
  });

  it('uses token boundaries and does not mistake Kaelen for Kael', () => {
    expect(findCharacterMention(characters[1], characters, "Kaelen's journal lay open.").matched).toBe(false);
  });

  it('does not add an ambiguous given name as an alias', () => {
    const ambiguous = [...characters, { entryName: 'Mira Stone' }];
    expect(characterAliases(ambiguous[0], ambiguous)).toEqual(['mira vale']);
    expect(findCharacterMention(ambiguous[0], ambiguous, 'Mira waited.').matched).toBe(false);
  });
});
