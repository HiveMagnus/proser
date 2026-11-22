import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  exportBook,
  generateFluxImage,
  listImages,
  generateProseBatch,
  generateBookSummary,
  getExportHistory,
  getRecommendations,
  getWritingStats,
  startFullBook,
  startGuidedImprove,
  startImproveQuality,
  startQualityReview,
  updateBook,
  deleteBook,
  getStructure,
} from '@/lib/api';

function createJsonResponse(data: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status: ok ? status : status || 500,
    headers: { 'content-type': 'application/json' },
  });
}

function createBlobResponse(blobText: string, ok = true, status = 200): Response {
  return new Response(blobText, {
    status: ok ? status : status || 500,
    headers: { 'content-type': 'text/plain' },
  });
}

describe('API route contracts', () => {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads structure metadata by default without losing canonical counts or source revisions', async () => {
    fetchMock.mockResolvedValue(
      createJsonResponse({
        success: true,
        data: {
          acts: [
            {
              id: 1,
              bookId: 7,
              actNumber: 1,
              chapters: [
                {
                  id: 2,
                  actId: 1,
                  chapterNumber: 1,
                  scenes: [
                    {
                      id: 3,
                      chapterId: 2,
                      sceneNumber: 1,
                      wordCount: 2400,
                      hasProse: true,
                      sourceBookRevisionId: 'book-revision',
                      sourceSceneRevisionId: 'scene-revision',
                      contentHash: 'a'.repeat(64),
                      projection: 'final',
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
    );
    const response = await getStructure('7');
    expect(fetchMock).toHaveBeenCalledWith('/api/books/7/structure', expect.anything());
    expect(response.data.acts[0]!.chapters[0]!.scenes[0]).toMatchObject({
      prose: null,
      wordCount: 2400,
      hasProse: true,
      sourceBookRevisionId: 'book-revision',
      sourceSceneRevisionId: 'scene-revision',
      contentHash: 'a'.repeat(64),
      projection: 'final',
    });
    fetchMock.mockResolvedValueOnce(createJsonResponse({ success: true, data: { acts: [] } }));
    await getStructure('7', { includeProse: true });
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/books/7/structure?includeProse=1',
      expect.anything(),
    );
  });
  it('updates books with PUT to the backend books route', async () => {
    fetchMock.mockResolvedValue(
      createJsonResponse({
        success: true,
        data: {
          id: 7,
          title: 'The Lantern Test',
          draftStatus: 'draft',
          wordCount: 0,
          summary: 'synopsis',
        },
      }),
    );

    const documentPreconditions = {
      operationId: 'owned-operation',
      expectedRevisionId: 'dialog-book-revision',
      expectedScopes: { structure: 'dialog-structure-revision' },
    };
    await updateBook(
      '7',
      { summary: 'synopsis', archetype: 'quest' },
      documentPreconditions,
      'actor/7',
    );

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/books/7',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({ 'X-Proser-Expected-User': 'actor%2F7' }),
        body: JSON.stringify({
          summary: 'synopsis',
          archetype: 'quest',
          storyArchetypeKey: 'quest',
          documentPreconditions,
        }),
      }),
    );
  });
  it('deletes only with dialog-source preconditions and the captured authenticated user', async () => {
    fetchMock.mockResolvedValueOnce(
      createJsonResponse({ success: true, data: { message: 'Deleted' } }),
    );
    const documentPreconditions = {
      operationId: 'delete-operation',
      expectedRevisionId: 'before',
      expectedScopes: { structure: 'structure-before' },
    };
    await deleteBook('7', documentPreconditions, 'actor/7');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/books/7',
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ documentPreconditions }),
        headers: expect.objectContaining({ 'X-Proser-Expected-User': 'actor%2F7' }),
      }),
    );
  });

  it('exports books from the mounted books export route', async () => {
    fetchMock.mockResolvedValue(createBlobResponse('exported'));

    await exportBook('42', {
      format: 'markdown',
      includeCodex: true,
      includeMetadata: false,
      includeSummaries: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/books/42/export?format=markdown&includeCodex=true&includeMetadata=false&includeSummaries=true&download=true',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('uses the generate summary endpoint for synopsis generation', async () => {
    fetchMock.mockResolvedValue(
      createJsonResponse({ success: true, data: 'A haunted harvest begins.' }),
    );

    const { data } = await generateBookSummary('10', 'Write a synopsis.');

    expect(data).toBe('A haunted harvest begins.');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/generate/summary',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ bookId: 10, prompt: 'Write a synopsis.', selectedModel: undefined }),
      }),
    );
  });

  it('uses Factory batch prose generation with explicit concurrency', async () => {
    fetchMock.mockResolvedValue(
      createJsonResponse({
        success: true,
        data: { results: [], summary: { total: 2 } },
      }),
    );

    await generateProseBatch({
      bookId: '10',
      maxConcurrency: 8,
      items: [
        { sceneId: '101', instructions: 'Draft opening scene.' },
        { sceneId: '102', instructions: 'Draft second scene.' },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/generate/prose/batch',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          bookId: '10',
          maxConcurrency: 8,
          items: [
            { sceneId: '101', instructions: 'Draft opening scene.' },
            { sceneId: '102', instructions: 'Draft second scene.' },
          ],
        }),
      }),
    );
  });

  it('sends an explicit idempotency key on every workflow start route', async () => {
    fetchMock.mockImplementation(async () =>
      createJsonResponse({ success: true, data: { runId: 'workflow-run' } }),
    );

    await startFullBook({ premise: 'A city forgets its own name.' }, 'full-book-key');
    await startQualityReview({ bookId: 7, model: 'qwen3.6-35b' }, 'review-key');
    await startImproveQuality({ bookId: 7, reviewRunIds: ['review-1'] }, 'improve-key');
    await startGuidedImprove({ bookId: 7, instruction: 'Tighten the opening.' }, 'guided-key');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/workflows/full-book',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Idempotency-Key': 'full-book-key' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/workflows/quality-review',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Idempotency-Key': 'review-key' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/workflows/improve-quality',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Idempotency-Key': 'improve-key' }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      '/api/workflows/guided-improve',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Idempotency-Key': 'guided-key' }),
      }),
    );
  });

  it('uses the Flux image route for Flux-specific generation', async () => {
    fetchMock.mockResolvedValue(
      createJsonResponse({
        success: true,
        data: { urls: ['/images/generated.png'] },
      }),
    );

    await generateFluxImage({
      prompt: 'A lighthouse in rain.',
      width: 1024,
      height: 768,
      steps: 20,
      cfgScale: 3.5,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/images/generate/flux',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          prompt: 'A lighthouse in rain.',
          n: undefined,
          bookId: undefined,
          width: 1024,
          height: 768,
          steps: 20,
          seed: undefined,
          cfg_scale: 3.5,
          distilled_cfg_scale: undefined,
          sampler_name: undefined,
          scheduler: undefined,
          model: undefined,
          response_format: undefined,
        }),
      }),
    );
  });

  it('uses authenticated same-origin URLs for image content', async () => {
    fetchMock.mockResolvedValue(
      createJsonResponse({
        success: true,
        data: {
          items: [
            {
              id: 17,
              url: 'https://factory.internal/images/legacy.png',
              prompt: 'Rain',
              entityType: 'scene',
              entityId: '4',
              bookId: '2',
              createdAt: '2026-07-15T00:00:00.000Z',
            },
          ],
          total: 1,
        },
      }),
    );

    const result = await listImages({ bookId: '2' });

    expect(result.items[0]?.url).toBe('/api/images/17/content');
  });

  it('falls back cleanly when optional analytics and recommendation routes are unavailable', async () => {
    fetchMock
      .mockResolvedValueOnce(
        createJsonResponse(
          { success: false, error: { message: 'Endpoint not found' } },
          false,
          404,
        ),
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          { success: false, error: { message: 'Endpoint not found' } },
          false,
          404,
        ),
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          { success: false, error: { message: 'Endpoint not found' } },
          false,
          404,
        ),
      );

    const stats = await getWritingStats('11', 30);
    const recommendations = await getRecommendations('11');
    const history = await getExportHistory('11');

    expect(stats.data).toEqual({
      daily: [],
      totalWords: 0,
      dailyAverage: 0,
      bestDay: null,
      streakDays: 0,
    });
    expect(recommendations.data).toEqual([]);
    expect(history.data).toEqual([]);
  });
});
