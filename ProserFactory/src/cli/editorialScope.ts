import type { EditorialScopeType } from '@/services/editorial/contracts';

export function parseEditorialScope(value = 'book'): { type: EditorialScopeType; id?: number } {
  const [type, rawId] = value.split(':');
  if (!['book', 'act', 'chapter', 'scene'].includes(type)) {
    throw new Error('Scope must be book, act:ID, chapter:ID, or scene:ID');
  }
  if (type === 'book') return { type };
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1) throw new Error('Non-book scope requires a positive ID');
  return { type: type as EditorialScopeType, id };
}
