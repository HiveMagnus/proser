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
jest.mock('../../cli/auth', () => ({ resolveCliUser: jest.fn().mockResolvedValue({ id: 42 }) }));
jest.mock('../../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { codexListCommand, codexAddCommand } from '../../cli/commands/codex';
import * as dbUtils from '../../cli/utils/database';
import { output } from '../../cli/utils/output';

const mockExit = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

const mockDb = {
  codexEntry: {
    findMany: jest.fn(),
    create: jest.fn(),
  },
  book: {
    findFirst: jest.fn(),
  },
};

(dbUtils.getDb as jest.Mock).mockReturnValue(mockDb);

describe('CLI codex:list command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (dbUtils.getDb as jest.Mock).mockReturnValue(mockDb);
    (dbUtils.initDatabase as jest.Mock).mockResolvedValue(undefined);
    mockDb.book.findFirst.mockResolvedValue({ id: 1, userId: 42 });
    (dbUtils.closeDatabase as jest.Mock).mockResolvedValue(undefined);
  });

  it('has correct command string', () => {
    expect(codexListCommand.command).toBe('codex:list <bookId>');
  });

  it('lists codex entries', async () => {
    mockDb.codexEntry.findMany.mockResolvedValue([
      { id: 1, entryType: 'character', entryName: 'Alice', entryDescription: 'Main protagonist' },
      { id: 2, entryType: 'location', entryName: 'Castle', entryDescription: 'An ancient fortress' },
    ]);

    const argv = { _: ['codex:list'], $0: 'proser-cli', bookId: 1, json: false } as any;
    await codexListCommand.handler(argv);

    expect(dbUtils.initDatabase).toHaveBeenCalled();
    expect(mockDb.book.findFirst).toHaveBeenCalledWith({ where: { id: 1, userId: 42 } });
    expect(mockDb.codexEntry.findMany).toHaveBeenCalledWith({
      where: { bookId: 1 },
    });
    expect((output.section as jest.Mock)).toHaveBeenCalledWith('Codex Entries (2)');
    expect(dbUtils.closeDatabase).toHaveBeenCalled();
  });

  it('filters by type when specified', async () => {
    mockDb.codexEntry.findMany.mockResolvedValue([]);

    const argv = { _: ['codex:list'], $0: 'proser-cli', bookId: 1, type: 'character', json: false } as any;
    await codexListCommand.handler(argv);

    expect(mockDb.codexEntry.findMany).toHaveBeenCalledWith({
      where: { bookId: 1, entryType: 'character' },
    });
  });

  it('shows info message for empty results', async () => {
    mockDb.codexEntry.findMany.mockResolvedValue([]);

    const argv = { _: ['codex:list'], $0: 'proser-cli', bookId: 1, json: false } as any;
    await codexListCommand.handler(argv);

    expect((output.info as jest.Mock)).toHaveBeenCalledWith('No codex entries found.');
  });

  it('outputs JSON when flag is set', async () => {
    mockDb.codexEntry.findMany.mockResolvedValue([
      { id: 1, entryType: 'character', entryName: 'Alice', entryDescription: 'Protagonist' },
    ]);

    const argv = { _: ['codex:list'], $0: 'proser-cli', bookId: 1, json: true } as any;
    await codexListCommand.handler(argv);

    expect((output.json as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        entries: expect.arrayContaining([
          expect.objectContaining({ entryName: 'Alice' }),
        ]),
      })
    );
  });
});

describe('CLI codex:add command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (dbUtils.getDb as jest.Mock).mockReturnValue(mockDb);
    (dbUtils.initDatabase as jest.Mock).mockResolvedValue(undefined);
    mockDb.book.findFirst.mockResolvedValue({ id: 1, userId: 42 });
    (dbUtils.closeDatabase as jest.Mock).mockResolvedValue(undefined);
  });

  it('has correct command string', () => {
    expect(codexAddCommand.command).toBe('codex:add <bookId> <name> <description>');
  });

  it('creates a codex entry with default type', async () => {
    mockDb.book.findFirst.mockResolvedValue({ id: 1. });
    mockDb.codexEntry.create.mockResolvedValue({
      id: 10,
      entryType: 'character',
      entryName: 'Bob',
      entryDescription: 'A sidekick',
    });

    const argv = {
      _: ['codex:add'], $0: 'proser-cli',
      bookId: 1, name: 'Bob', description: 'A sidekick', type: 'character', json: false,
    } as any;

    await codexAddCommand.handler(argv);

    expect(mockDb.codexEntry.create).toHaveBeenCalledWith({
      data: {
        bookId: 1,
        entryType: 'character',
        entryName: 'Bob',
        entryDescription: 'A sidekick',
      },
    });
    expect((output.success as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('Bob')
    );
  });

  it('errors when book not found', async () => {
    mockDb.book.findFirst.mockResolvedValue(null);

    const argv = {
      _: ['codex:add'], $0: 'proser-cli',
      bookId: 999, name: 'X', description: 'Y', type: 'character', json: false,
    } as any;

    await codexAddCommand.handler(argv);

    expect((output.error as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('999')
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('outputs JSON on success', async () => {
    mockDb.book.findFirst.mockResolvedValue({ id: 1 });
    mockDb.codexEntry.create.mockResolvedValue({
      id: 11,
      entryType: 'location',
      entryName: 'Tower',
      entryDescription: 'Tall structure',
    });

    const argv = {
      _: ['codex:add'], $0: 'proser-cli',
      bookId: 1, name: 'Tower', description: 'Tall structure', type: 'location', json: true,
    } as any;

    await codexAddCommand.handler(argv);

    expect((output.json as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        entry: expect.objectContaining({ entryName: 'Tower', entryType: 'location' }),
      })
    );
  });
});
