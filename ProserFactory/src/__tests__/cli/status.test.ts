/// <reference types="jest" />

jest.mock('../../cli/utils/database', () => ({
  initDatabase: jest.fn().mockResolvedValue(undefined),
  closeDatabase: jest.fn().mockResolvedValue(undefined),
  getDb: jest.fn(),
}));
jest.mock('../../cli/utils/output', () => ({
  output: {
    success: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
    info: jest.fn(),
    section: jest.fn(),
    data: jest.fn(),
    startSpinner: jest.fn(),
    updateSpinner: jest.fn(),
    succeedSpinner: jest.fn(),
    failSpinner: jest.fn(),
    stopSpinner: jest.fn(),
    newline: jest.fn(),
    table: jest.fn(),
    json: jest.fn(),
  },
}));
jest.mock('../../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { statusCommand } from '../../cli/commands/status';
import * as dbUtils from '../../cli/utils/database';
import { output } from '../../cli/utils/output';

const mockExit = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

const makeBook = (overrides = {}) => ({
  id: 1,
  title: 'Test Novel',
  genre: 'fantasy',
  draftStatus: 'draft',
  acts: [
    {
      id: 1,
      actNumber: 1,
      chapters: [
        {
          id: 1,
          chapterNumber: 1,
          scenes: [
            { id: 1, sceneNumber: 1, prose: 'Some prose' },
            { id: 2, sceneNumber: 2, prose: null },
            { id: 3, sceneNumber: 3, prose: '' },
          ],
        },
      ],
    },
  ],
  codexEntries: [{ id: 1 }, { id: 2 }],
  ...overrides,
});

const mockDb = {
  book: {
    findUnique: jest.fn(),
  },
};

(dbUtils.getDb as jest.Mock).mockReturnValue(mockDb);

describe('CLI status command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (dbUtils.getDb as jest.Mock).mockReturnValue(mockDb);
    (dbUtils.initDatabase as jest.Mock).mockResolvedValue(undefined);
    (dbUtils.closeDatabase as jest.Mock).mockResolvedValue(undefined);
  });

  it('has correct command string', () => {
    expect(statusCommand.command).toBe('status <bookId>');
  });

  it('displays book status with correct progress calculation', async () => {
    const book = makeBook();
    mockDb.book.findUnique.mockResolvedValue(book);

    const argv = { _: ['status'], $0: 'proser-cli', bookId: 1, json: false } as any;
    await statusCommand.handler(argv);

    expect(dbUtils.initDatabase).toHaveBeenCalled();
    // 1 of 3 scenes has prose → 33.3%
    expect((output.data as jest.Mock)).toHaveBeenCalledWith('Scenes Generated', '1 / 3');
    expect((output.data as jest.Mock)).toHaveBeenCalledWith('Completion', '33.3%');
    expect((output.data as jest.Mock)).toHaveBeenCalledWith('Codex Entries', 2);
    expect(dbUtils.closeDatabase).toHaveBeenCalled();
  });

  it('outputs JSON with structure summary', async () => {
    const book = makeBook();
    mockDb.book.findUnique.mockResolvedValue(book);

    const argv = { _: ['status'], $0: 'proser-cli', bookId: 1, json: true } as any;
    await statusCommand.handler(argv);

    expect((output.json as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        book: expect.objectContaining({
          id: 1,
          structure: expect.objectContaining({ acts: 1, chapters: 1, scenes: 3 }),
          progress: expect.objectContaining({ scenesGenerated: 1, totalScenes: 3 }),
        }),
      })
    );
  });

  it('handles missing book', async () => {
    mockDb.book.findUnique.mockResolvedValue(null);

    const argv = { _: ['status'], $0: 'proser-cli', bookId: 999, json: false } as any;
    await statusCommand.handler(argv);

    expect((output.error as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('999')
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('handles untitled book', async () => {
    const book = makeBook({ title: null });
    mockDb.book.findUnique.mockResolvedValue(book);

    const argv = { _: ['status'], $0: 'proser-cli', bookId: 1, json: false } as any;
    await statusCommand.handler(argv);

    expect((output.data as jest.Mock)).toHaveBeenCalledWith('Title', 'Untitled');
  });
});
