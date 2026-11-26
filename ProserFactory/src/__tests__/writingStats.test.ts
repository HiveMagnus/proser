import { randomUUID } from 'node:crypto';
import request from 'supertest';
import app from '../index';
import { databaseService } from '../lib/database';
import { addDays, localDate, requireDatabaseTimeZone, summarizeWriting, validTimeZone, type DaySnapshot } from '../services/writingStatsService';

const scene = (sceneId: number, revisionId: string, wordCount: number) => ({ sceneId, revisionId, wordCount });

describe('writing statistics summary', () => {
  const origins = new Map([['m1', 'manual'], ['m2', 'manual'], ['m3', 'manual'], ['i1', 'import'], ['a1', 'ai']]);

  it('credits hand-saved changes as written and imports or AI text as other', () => {
    const snapshots: DaySnapshot[] = [
      { day: '2026-11-20', scenes: [scene(1, 'i1', 5000)] },
      { day: '2026-11-21', scenes: [scene(1, 'm1', 5300), scene(2, 'a1', 800)] },
      { day: '2026-11-23', scenes: [scene(1, 'm2', 5200), scene(2, 'a1', 800), scene(3, 'm3', 400)] },
    ];
    const stats = summarizeWriting({ bookId: 1, timeZone: 'UTC', today: '2026-11-23', days: 7, snapshots, origins, goal: null });
    expect(stats.days.map((day) => [day.date, day.written, day.other, day.totalWords])).toEqual([
      ['2026-11-17', 0, 0, 0], ['2026-11-18', 0, 0, 0], ['2026-11-19', 0, 0, 0],
      ['2026-11-20', 0, 5000, 5000], ['2026-11-21', 300, 800, 6100], ['2026-11-22', 0, 0, 6100], ['2026-11-23', 300, 0, 6400],
    ]);
    expect(stats.totalWords).toBe(6400);
    expect(stats.writtenInPeriod).toBe(600);
    expect(stats.bestDay).toEqual({ date: '2026-11-21', written: 300 });
    expect(stats.streak).toEqual({ current: 1, longest: 1 });
  });

  it('measures change from the snapshot before the window and keeps a streak alive during today', () => {
    const baseline = { day: '2026-11-16', scenes: [scene(1, 'i1', 1000)] };
    const snapshots: DaySnapshot[] = [
      { day: '2026-11-21', scenes: [scene(1, 'm1', 1600)] },
      { day: '2026-11-22', scenes: [scene(1, 'm2', 2200)] },
    ];
    const goal = { targetWords: 10_000, deadline: '2026-11-30', dailyWords: 500 };
    const stats = summarizeWriting({ bookId: 1, timeZone: 'UTC', today: '2026-11-23', days: 7, baseline, snapshots, origins, goal });
    expect(stats.days.find((day) => day.date === '2026-11-21')?.written).toBe(600);
    expect(stats.streak).toEqual({ current: 2, longest: 2 });
    expect(stats.pacing).toEqual({ remainingWords: 7800, daysLeft: 8, wordsPerDayNeeded: 975, todayRemaining: 500 });
  });

  it('validates time zones and computes local dates', () => {
    expect(validTimeZone(undefined)).toBe('UTC');
    expect(validTimeZone('Europe/Paris')).toBe('Europe/Paris');
    expect(() => validTimeZone("UTC'; DROP TABLE books; --")).toThrow('IANA');
    expect(localDate(new Date('2026-11-26T23:30:00Z'), 'Asia/Tokyo')).toBe('2026-11-27');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('writing statistics routes', () => {
  const prefix = `jest-writing-${Date.now()}`;
  let owner: { id: number; githubId: string };
  let other: { id: number; githubId: string };
  let bookId: number;
  const as = (user: { id: number; githubId: string }) => (test: request.Test) =>
    test.set('x-user-id', String(user.id)).set('x-github-id', user.githubId).set('x-username', user.githubId);

  beforeAll(async () => {
    owner = await databaseService.client.user.create({ data: { githubId: `${prefix}-owner`, username: `${prefix}-owner` } });
    other = await databaseService.client.user.create({ data: { githubId: `${prefix}-other`, username: `${prefix}-other` } });
    bookId = (await databaseService.client.book.create({ data: { userId: owner.id, title: 'Stats fixture' } })).id;
    const now = Date.now();
    const revision = async (id: string, origin: string) => databaseService.client.sceneDocumentRevision.create({
      data: { id, bookId, sceneId: 900_001, schemaVersion: 1, contentHash: id, document: {}, actorId: owner.id, origin },
    });
    const book = async (words: number, revisionId: string, at: number) => databaseService.client.bookDocumentRevision.create({
      data: { id: randomUUID(), bookId, contentHash: randomUUID(), manifest: { schemaVersion: 1, scenes: [{ sceneId: 900_001, chapterId: 1, sceneNumber: 1, revisionId, contentHash: revisionId, wordCount: words }] }, actorId: owner.id, operationId: randomUUID(), createdAt: new Date(at) },
    });
    const yesterday = randomUUID(); const today = randomUUID();
    await revision(yesterday, 'import'); await revision(today, 'manual');
    await book(1000, yesterday, now - 26 * 60 * 60 * 1000);
    await book(1250, today, now);
  });

  afterAll(async () => {
    await databaseService.client.bookDocumentRevision.deleteMany({ where: { bookId } });
    await databaseService.client.sceneDocumentRevision.deleteMany({ where: { bookId } });
    await databaseService.client.user.deleteMany({ where: { githubId: { startsWith: prefix } } });
  });

  it('reports today’s hand-written words, stores goals and derives next steps', async () => {
    const stats = await as(owner)(request(app).get(`/api/books/${bookId}/writing-stats`).query({ days: 7 }));
    expect(stats.status).toBe(200);
    expect(stats.body.data.totalWords).toBe(1250);
    expect(stats.body.data.days).toHaveLength(7);
    expect(stats.body.data.days.at(-1).written).toBe(250);
    expect(stats.body.data.goal).toBeNull();

    const saved = await as(owner)(request(app).put(`/api/books/${bookId}/writing-goal`).send({ targetWords: 80_000, deadline: '2099-01-01', dailyWords: 1000 }));
    expect(saved.status).toBe(200);
    expect(saved.body.data.goal).toEqual({ targetWords: 80_000, deadline: '2099-01-01', dailyWords: 1000 });
    const paced = await as(owner)(request(app).get(`/api/books/${bookId}/writing-stats`));
    expect(paced.body.data.pacing.todayRemaining).toBe(750);
    expect(paced.body.data.pacing.remainingWords).toBe(78_750);

    const next = await as(owner)(request(app).get(`/api/books/${bookId}/recommendations`));
    expect(next.status).toBe(200);
    const ids = next.body.data.recommendations.map((item: { id: string }) => item.id);
    expect(ids).toEqual(expect.arrayContaining(['daily-goal', 'deadline-pace', 'story-bible', 'archetype']));
    expect(ids).not.toContain('set-goal');

    const cleared = await as(owner)(request(app).put(`/api/books/${bookId}/writing-goal`).send({ targetWords: null, deadline: null, dailyWords: null }));
    expect(cleared.body.data.goal).toBeNull();
  });

  it('refuses other writers, bad input and unknown time zones', async () => {
    expect((await as(other)(request(app).get(`/api/books/${bookId}/writing-stats`))).status).toBe(404);
    expect((await as(other)(request(app).put(`/api/books/${bookId}/writing-goal`).send({ targetWords: 1, deadline: null, dailyWords: null }))).status).toBe(404);
    expect((await as(owner)(request(app).get(`/api/books/${bookId}/writing-stats`).query({ tz: 'Mars/Olympus' }))).status).toBe(422);
    expect((await as(owner)(request(app).get(`/api/books/${bookId}/writing-stats`).query({ days: 3 }))).status).toBe(422);
    expect((await as(owner)(request(app).put(`/api/books/${bookId}/writing-goal`).send({ targetWords: -5, deadline: null, dailyWords: null }))).status).toBe(422);
    expect((await as(owner)(request(app).put(`/api/books/${bookId}/writing-goal`).send({ targetWords: 1000, deadline: '2026-02-30', dailyWords: null }))).status).toBe(422);
    expect((await as(owner)(request(app).put(`/api/books/${bookId}/writing-goal`).send({ targetWords: 1000, deadline: '2028-02-29', dailyWords: null }))).status).toBe(200);
    // A zone the runtime knows but PostgreSQL does not is refused, not a server error.
    await expect(requireDatabaseTimeZone('Europe/Paris')).resolves.toBeUndefined();
    await expect(requireDatabaseTimeZone('Fixture/Unknown')).rejects.toThrow('tz is not a time zone the database knows');
    expect((await request(app).get(`/api/books/${bookId}/writing-stats`)).status).toBe(401);
  });

  it('lists the story archetypes', async () => {
    const res = await as(owner)(request(app).get('/api/plot/archetypes'));
    expect(res.status).toBe(200);
    expect(res.body.data.archetypes.length).toBeGreaterThan(5);
    expect(res.body.data.archetypes[0]).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String) }));
  });
});
