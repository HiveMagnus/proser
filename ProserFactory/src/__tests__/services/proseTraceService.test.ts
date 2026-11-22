jest.mock('../../lib/database', () => ({
  databaseService: {
    client: {
      scene: {
        findMany: jest.fn(),
      },
      proseTrace: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
    },
  },
}));

jest.mock('../../lib/logger', () => ({
  __esModule: true,
  default: {
    warn: jest.fn(),
  },
}));

jest.mock('../../lib/ai/router', () => ({
  defaultModelRouter: {
    choose: jest.fn(),
  },
}));

jest.mock('../../lib/resilience', () => ({
  withRetry: jest.fn(),
}));

jest.mock('../../lib/metrics', () => ({
  time: jest.fn(),
}));

import { databaseService } from '../../lib/database';
import { ProseTraceService } from '../../services/proseTraceService';

describe('ProseTraceService', () => {
  const service = new ProseTraceService();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('treats missing prose trace tables as an empty latest-trace state', async () => {
    (databaseService.client.proseTrace.findFirst as jest.Mock).mockRejectedValue(
      new Error('DriverAdapterError: SQLITE_ERROR: no such table: main.prose_traces'),
    );

    await expect(service.getLatestTraceForScene(11, 10, 301)).resolves.toBeNull();
  });

  it('returns an empty quality overview when trace tables are unavailable', async () => {
    (databaseService.client.scene.findMany as jest.Mock).mockResolvedValue([
      {
        id: 301,
        chapterId: 201,
        sceneNumber: 1,
        chapter: {
          title: 'The Lantern Test',
          chapterNumber: 1,
        },
      },
    ]);
    (databaseService.client.proseTrace.findMany as jest.Mock).mockRejectedValue(
      new Error('DriverAdapterError: SQLITE_ERROR: no such table: main.prose_traces'),
    );

    await expect(service.getBookQualityOverview(11, 10)).resolves.toMatchObject({
      overallScore: 0,
      reviewedSceneCount: 0,
      issues: [],
    });
  });
});
