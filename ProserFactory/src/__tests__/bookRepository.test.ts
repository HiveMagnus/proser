/// <reference types="jest" />
import { databaseService } from '../lib/database';
import { BookRepository } from '../core/persistence/bookRepository';

async function ensureUser() {
  return databaseService.client.user.upsert({
    where: { githubId: 'jest-repo' },
    update: { username: 'jest-repo' },
    create: { githubId: 'jest-repo', username: 'jest-repo' }
  });
}

describe('BookRepository', () => {
  let userId: number;
  let repo: BookRepository;

  beforeAll(async () => {
    userId = (await ensureUser()).id;
    repo = new BookRepository(databaseService.client as any);
  });

  it('creates and fetches a book', async () => {
    const created = await repo.create({ userId, title: 'Repo Book', genre: 'fantasy' });
    expect(created.id).toBeGreaterThan(0);
    const fetched = await repo.findById(userId, created.id);
    expect(fetched?.title).toBe('Repo Book');
  });

  it('lists books by user with pagination', async () => {
    const list = await repo.listByUser(userId, { page: 1, pageSize: 10 });
    expect(Array.isArray(list)).toBe(true);
  });

  it('patch-updates an existing book', async () => {
    const b = await repo.create({ userId, title: 'Patch Me' });
    const updated = await repo.updatePatch(userId, b.id, { title: 'Patched' });
    expect(updated?.title).toBe('Patched');
  });

  it('updatePatch returns null if not owned/not found', async () => {
    const res = await repo.updatePatch(999999, 1, { title: 'Nope' });
    expect(res).toBeNull();
  });
});
