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

jest.mock('../../cli/auth', () => ({
  resolveCliUser: jest.fn().mockResolvedValue({ id: 1 }),
}));

jest.mock('../../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import { listCommand } from '../../cli/commands/list';
import * as dbUtils from '../../cli/utils/database';
import { output } from '../../cli/utils/output';

const mockDb = {
  book: {
    findMany: jest.fn(),
  },
};

describe('CLI list command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (dbUtils.getDb as jest.Mock).mockReturnValue(mockDb);
  });

  it('outputs table rows in human mode', async () => {
    mockDb.book.findMany.mockResolvedValue([
      {
        id: 7,
        title: 'Book A',
        genre: 'fantasy',
        draftStatus: 'draft',
        acts: [{ chapters: [{ scenes: [{ prose: 'hello' }, { prose: '' }] }] }],
      },
    ]);

    await listCommand.handler({ _: ['list'], $0: 'proser-cli', json: false } as any);

    expect(output.section).toHaveBeenCalledWith('Books (1)');
    expect(output.table).toHaveBeenCalled();
  });

  it('outputs json in --json mode', async () => {
    mockDb.book.findMany.mockResolvedValue([]);

    await listCommand.handler({ _: ['list'], $0: 'proser-cli', json: true } as any);

    expect(output.json).toHaveBeenCalledWith({ success: true, userId: 1, count: 0, books: [] });
  });
});
