export type CanonicalGenreKey =
  | 'fantasy'
  | 'sci-fi'
  | 'thriller'
  | 'romance'
  | 'literary'
  | 'mystery'
  | 'horror';

const DIRECT_GENRES: CanonicalGenreKey[] = [
  'fantasy',
  'sci-fi',
  'thriller',
  'romance',
  'literary',
  'mystery',
  'horror',
];

const ALIAS_MAP: Array<[RegExp, CanonicalGenreKey]> = [
  [/^(epic|dark|grimdark|urban|high|low)\s+fantasy$/i, 'fantasy'],
  [/^(fantasy|romantasy)$/i, 'fantasy'],
  [/^(science[\s-]?fiction|sci[\s-]?fi|space opera|cyberpunk)$/i, 'sci-fi'],
  [/^(thriller|suspense|action thriller)$/i, 'thriller'],
  [/^(romance|dark romance|dark-romance|paranormal romance)$/i, 'romance'],
  [/^(literary|literary fiction|general fiction|fiction|contemporary)$/i, 'literary'],
  [/^(mystery|crime|detective|noir|whodunit)$/i, 'mystery'],
  [/^(horror|gothic horror|cosmic horror)$/i, 'horror'],
];

function normalizeWhitespace(value: string): string {
  return value.trim().toLowerCase().replace(/[_/]+/g, ' ').replace(/\s+/g, ' ');
}

export function normalizeGenreKey(value?: string | null): CanonicalGenreKey | null {
  if (!value) return null;

  const normalized = normalizeWhitespace(value);
  if (!normalized) return null;

  if ((DIRECT_GENRES as string[]).includes(normalized)) {
    return normalized as CanonicalGenreKey;
  }

  for (const [pattern, genreKey] of ALIAS_MAP) {
    if (pattern.test(normalized)) {
      return genreKey;
    }
  }

  if (normalized.includes('fantasy')) return 'fantasy';
  if (normalized.includes('romance')) return 'romance';
  if (normalized.includes('mystery') || normalized.includes('detective') || normalized.includes('crime')) return 'mystery';
  if (normalized.includes('thriller') || normalized.includes('suspense')) return 'thriller';
  if (normalized.includes('science fiction') || normalized.includes('sci fi') || normalized.includes('scifi')) return 'sci-fi';
  if (normalized.includes('horror')) return 'horror';
  if (normalized.includes('literary')) return 'literary';

  return null;
}

export function isCanonicalGenreKey(value?: string | null): value is CanonicalGenreKey {
  return normalizeGenreKey(value) === value;
}
