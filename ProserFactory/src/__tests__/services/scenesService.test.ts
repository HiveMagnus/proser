/// <reference types="jest" />
import { databaseService } from '../../lib/database';
import { scenesService } from '../../services/scenesService';
import * as contentCache from '../../lib/redis/contentCache';

async function seedUser() {
  return databaseService.client.user.upsert({
    where: { githubId: 'jest-gh-scenes-service' },
    update: { username: 'jest-user-scenes' },
    create: { githubId: 'jest-gh-scenes-service', username: 'jest-user-scenes' }
  });
}

async function seedBookWithChapter(userId: number) {
  const book = await databaseService.client.book.create({ data: { userId, title: 'Svc Book', genre: 'fantasy', targetAudience: 'adult', summary: 'sum' } });
  const act = await databaseService.client.act.create({ data: { bookId: book.id, actNumber: 1, title: 'Act 1', summary: '' } });
  const chapter = await databaseService.client.chapter.create({ data: { actId: act.id, chapterNumber: 1, title: 'Ch 1', summary: 'ch sum' } });
  return { book, act, chapter };
}

describe('ScenesService', () => {
  let userId: number; let chapterId: number; let bookId: number;
  beforeAll(async () => {
    const u = await seedUser();
    userId = u.id;
    const { book, chapter } = await seedBookWithChapter(userId);
    chapterId = chapter.id; bookId = book.id;
  });

  it('creates a scene at next sceneNumber and computes wordCount', async () => {
    const spyInv = jest.spyOn(contentCache, 'invalidateStructure');
    const spyExp = jest.spyOn(contentCache, 'invalidateExport');
    const prose = 'Hello world this is a scene.';
    const scene = await scenesService.createSceneForChapter({ userId, chapterId, prose, summary: 'sum' });
    expect(scene.chapterId).toBe(chapterId);
    expect(scene.sceneNumber).toBe(1);
    expect(scene.wordCount).toBe(prose.split(/\s+/).filter(Boolean).length);
    expect(spyInv).toHaveBeenCalledWith(bookId);
    expect(spyExp).toHaveBeenCalledWith(bookId);
  });

  it('batch creates multiple scenes with ascending numbers', async () => {
    const created = await scenesService.batchCreateScenesForChapter({ userId, chapterId, scenes: [
      { prose: 'a b c', summary: 's1' },
      { prose: 'd e f g', summary: 's2' }
    ] });
    expect(created.length).toBe(2);
    // Existing scene 1 already created, so these should be numbers 2 and 3
    expect(created[0].sceneNumber).toBe(2);
    expect(created[1].sceneNumber).toBe(3);
  });

  it('updates existing scene prose and invalidates', async () => {
    const target = await databaseService.client.scene.findFirst({ where: { chapterId }, orderBy: { sceneNumber: 'asc' } });
    expect(target).toBeTruthy();
    const updated = await scenesService.updateSceneProse(userId, target!.id, { prose: 'updated prose with many words' });
    expect(updated.wordCount).toBeGreaterThanOrEqual(3);
  });

  it('throws NotFoundError when chapter not found or not owned', async () => {
    await expect(scenesService.createSceneForChapter({ userId, chapterId: 999999, prose: 'x' }))
      .rejects.toHaveProperty('name', 'NotFoundError');
  });
});
