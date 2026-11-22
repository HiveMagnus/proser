/// <reference types="jest" />

/**
 * Unit tests for CLI create command.
 * We test the handler logic by calling it directly with mock argv,
 * mocking the database and output utilities.
 */

// Mock modules before imports
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

import { createCommand } from '../../cli/commands/create';
import * as dbUtils from '../../cli/utils/database';
import { output } from '../../cli/utils/output';

const mockDb = {
  user: {
    upsert: jest.fn(),
  },
  book: {
    create: jest.fn(),
  },
};

(dbUtils.getDb as jest.Mock).mockReturnValue(mockDb);

// Prevent process.exit from killing the test process
const mockExit = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

describe('CLI create command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (dbUtils.getDb as jest.Mock).mockReturnValue(mockDb);
    (dbUtils.initDatabase as jest.Mock).mockResolvedValue(undefined);
    (dbUtils.closeDatabase as jest.Mock).mockResolvedValue(undefined);
  });

  it('has correct command string and description', () => {
    expect(createCommand.command).toBe('create <prompt>');
    expect(createCommand.describe).toMatch(/create.*book/i);
  });

  it('creates a book with default CLI user', async () => {
    const mockUser = { id: 1, githubId: 'cli-local-user', username: 'cli-user' };
    mockDb.user.upsert.mockResolvedValue(mockUser);
    mockDb.book.create.mockResolvedValue({
      id: 42,
      title: 'Test Book',
      genre: 'fantasy',
      summary: 'A test prompt',
      draftStatus: 'draft',
    });

    const argv = {
      _: ['create'],
      $0: 'proser-cli',
      prompt: 'A test prompt',
      title: 'Test Book',
      genre: 'fantasy',
      json: false,
    } as any;

    await createCommand.handler(argv);

    expect(dbUtils.initDatabase).toHaveBeenCalled();
    expect(mockDb.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { githubId: 'cli-local-user' },
      })
    );
    expect(mockDb.book.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 1,
        summary: 'A test prompt',
        title: 'Test Book',
        genre: 'fantasy',
        draftStatus: 'draft',
      }),
    });
    expect((output.success as jest.Mock)).toHaveBeenCalled();
    expect(dbUtils.closeDatabase).toHaveBeenCalled();
  });

  it('uses provided user-id when specified', async () => {
    mockDb.book.create.mockResolvedValue({
      id: 43,
      title: null,
      genre: null,
      summary: 'Some prompt',
      draftStatus: 'draft',
    });

    const argv = {
      _: ['create'],
      $0: 'proser-cli',
      prompt: 'Some prompt',
      'user-id': 99,
      json: false,
    } as any;

    await createCommand.handler(argv);

    // Should NOT call user.upsert when userId is provided
    expect(mockDb.user.upsert).not.toHaveBeenCalled();
    expect(mockDb.book.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 99 }),
    });
  });

  it('outputs JSON when --json flag is set', async () => {
    const mockUser = { id: 1, githubId: 'cli-local-user', username: 'cli-user' };
    mockDb.user.upsert.mockResolvedValue(mockUser);
    mockDb.book.create.mockResolvedValue({
      id: 44,
      title: 'JSON Test',
      genre: 'sci-fi',
      summary: 'Prompt text',
      draftStatus: 'draft',
    });

    const argv = {
      _: ['create'],
      $0: 'proser-cli',
      prompt: 'Prompt text',
      title: 'JSON Test',
      genre: 'sci-fi',
      json: true,
    } as any;

    await createCommand.handler(argv);

    expect((output.json as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, book: expect.objectContaining({ id: 44 }) })
    );
  });

  it('handles database errors gracefully', async () => {
    mockDb.user.upsert.mockRejectedValue(new Error('DB connection failed'));

    const argv = {
      _: ['create'],
      $0: 'proser-cli',
      prompt: 'This prompt will cause a database failure during creation',
      json: false,
    } as any;

    await createCommand.handler(argv);

    expect((output.error as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('DB connection failed')
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
