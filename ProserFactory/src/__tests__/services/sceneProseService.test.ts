// Mock the database and AI services
jest.mock('../../lib/database', () => ({
  databaseService: {
    client: {
      scene: {
        findUnique: jest.fn(),
        findFirst: jest.fn()
      },
      codexEntry: {
        findMany: jest.fn()
      }
    }
  }
}));
jest.mock('../../lib/ai/router', () => ({
  defaultModelRouter: {
    forRequest: jest.fn().mockReturnValue({
      id: 'mock-provider',
      getModel: jest.fn().mockReturnValue('mock-model'),
      generateText: jest.fn().mockResolvedValue('Mock generated text'),
      supports: jest.fn().mockReturnValue(true)
    }),
    getProvider: jest.fn().mockResolvedValue({
      id: 'mock-provider',
      generateText: jest.fn().mockResolvedValue('Mock generated text'),
      supports: jest.fn().mockReturnValue(true)
    }),
    choose: jest.fn().mockReturnValue({
      id: 'mock-provider',
      generateText: jest.fn().mockResolvedValue('Mock generated text'),
      supports: jest.fn().mockReturnValue(true)
    })
  }
}));
jest.mock('../../lib/ai/autoRouter', () => ({
  autoActivateAdapter: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../services/liveProseJudgeService', () => ({
  enqueueLiveProseJudge: jest.fn().mockResolvedValue('submitted'),
}));
jest.mock('../../prompts/service', () => ({
  interpolatePromptByKey: jest.fn().mockResolvedValue('Test prompt with context')
}));

import { isSufficientReviewRevision, mergeProseContinuation, SceneProseService } from '../../services/sceneProseService';
import { databaseService } from '../../lib/database';

describe('SceneProseService', () => {
  let service: SceneProseService;
  
  beforeEach(() => {
    service = new SceneProseService();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('joins truncated prose only when the continuation repeats a bounded overlap', () => {
    const overlap = 'the lantern guttered while the archive door opened';
    expect(mergeProseContinuation(`Before ${overlap}`, `${overlap} after`)).toBe(`Before ${overlap} after`);
    expect(() => mergeProseContinuation('Before the verified ending', 'An unrelated restart')).toThrow('incompatible terminal reason');
  });

  describe('generateProse', () => {
    it('should generate prose with minimal context', async () => {
      const mockScene = {
        id: 1,
        sceneNumber: 1,
        summary: 'Test scene summary',
        outline: 'Test outline',
        chapter: {
          id: 1,
          chapterNumber: 1,
          title: 'Test Chapter',
          summary: 'Chapter summary',
          act: {
            id: 1,
            actNumber: 1,
            title: 'Test Act',
            summary: 'Act summary',
            book: {
              id: 1,
              title: 'Test Book',
              genre: 'Fiction',
              summary: 'Book summary',
              targetAudience: 'Adults'
            }
          }
        }
      };

      (databaseService.client.scene.findFirst as jest.Mock).mockResolvedValue(mockScene);
      (databaseService.client.codexEntry.findMany as jest.Mock).mockResolvedValue([]);

      const context = {
        bookId: 1,
        sceneId: 1,
        title: 'Test Book'
      };

      const result = await service.generateProse(context);

      expect(result).toBeDefined();
  expect(typeof result.prose).toBe('string');
  expect(result.prose.length).toBeGreaterThan(0);
      expect(result.wordCount).toBeGreaterThan(0);
  expect(typeof result.model === 'string' || result.model === undefined).toBe(true);
    });
  });

  describe('reviewProse', () => {
    it('rejects a tiny review response in place of a full scene', () => {
      const original = 'A complete scene remains intact. '.repeat(100);
      expect(isSufficientReviewRevision(original, 'Looks good.')).toBe(false);
      expect(isSufficientReviewRevision(original, 'A complete scene remains intact. '.repeat(80))).toBe(true);
    });

    it('should revise prose using the review prompt', async () => {
      const result = await service.reviewProse(
        'Original prose here',
        {
          pov: 'third',
          tense: 'past',
          maxEditPct: 10,
          instruction: 'Make it more vivid',
          sceneOutline: 'A tense hallway confrontation.',
        },
        { selectedModel: 'mock-model' },
      );
      expect(result.revised).toBeDefined();
      expect(typeof result.revised).toBe('string');
      expect(result.model).toBeDefined();
      expect(result.provenance).toMatchObject({ providerId: 'mock-provider', requestedModel: 'mock-model', configuredModel: 'mock-model', recipe: 'prose-review', recipeVersion: '1.0.0' });
    });
  });
});
