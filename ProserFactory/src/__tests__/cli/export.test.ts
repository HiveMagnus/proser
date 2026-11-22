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
jest.mock('fs/promises', () => ({
  writeFile: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined),
}));

import { exportCommand } from '../../cli/commands/export';
import * as dbUtils from '../../cli/utils/database';
import { output } from '../../cli/utils/output';
import * as fsPromises from 'fs/promises';

const mockExit = jest.spyOn(process, 'exit').mockImplementation((() => {}) as any);

const makeBook = () => ({
  id: 1,
  title: 'Test Novel',
  summary: 'A brave adventure',
  genre: 'fantasy',
  acts: [
    {
      id: 1,
      actNumber: 1,
      title: 'Act One',
      summary: 'The beginning',
      chapters: [
        {
          id: 1,
          chapterNumber: 1,
          title: 'Chapter One',
          scenes: [
            { id: 1, sceneNumber: 1, prose: 'Once upon a time.' },
            { id: 2, sceneNumber: 2, prose: 'And then it happened.' },
          ],
        },
      ],
    },
  ],
});

const mockDb = {
  book: {
    findUnique: jest.fn(),
  },
};

(dbUtils.getDb as jest.Mock).mockReturnValue(mockDb);

describe('CLI export command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (dbUtils.getDb as jest.Mock).mockReturnValue(mockDb);
    (dbUtils.initDatabase as jest.Mock).mockResolvedValue(undefined);
    (dbUtils.closeDatabase as jest.Mock).mockResolvedValue(undefined);
    (fsPromises.writeFile as jest.Mock).mockResolvedValue(undefined);
  });

  it('has correct command string', () => {
    expect(exportCommand.command).toBe('export <bookId>');
  });

  it('exports book as markdown', async () => {
    mockDb.book.findUnique.mockResolvedValue(makeBook());

    const argv = {
      _: ['export'], $0: 'proser-cli',
      bookId: 1, format: 'markdown', 'output-dir': './out', json: false,
    } as any;

    await exportCommand.handler(argv);

    expect(dbUtils.initDatabase).toHaveBeenCalled();
    expect(fsPromises.writeFile).toHaveBeenCalled();
    const writeCall = (fsPromises.writeFile as jest.Mock).mock.calls[0];
    expect(writeCall[0]).toMatch(/\.md$/);
    // Content should include the title
    expect(writeCall[1]).toContain('Test Novel');
    expect((output.success as jest.Mock)).toHaveBeenCalled();
    expect(dbUtils.closeDatabase).toHaveBeenCalled();
  });

  it('exports book as plain text', async () => {
    mockDb.book.findUnique.mockResolvedValue(makeBook());

    const argv = {
      _: ['export'], $0: 'proser-cli',
      bookId: 1, format: 'txt', 'output-dir': './out', json: false,
    } as any;

    await exportCommand.handler(argv);

    const writeCall = (fsPromises.writeFile as jest.Mock).mock.calls[0];
    expect(writeCall[0]).toMatch(/\.txt$/);
    expect(writeCall[1]).toContain('Once upon a time.');
  });

  it('exports book as JSON', async () => {
    mockDb.book.findUnique.mockResolvedValue(makeBook());

    const argv = {
      _: ['export'], $0: 'proser-cli',
      bookId: 1, format: 'json', 'output-dir': './out', json: false,
    } as any;

    await exportCommand.handler(argv);

    const writeCall = (fsPromises.writeFile as jest.Mock).mock.calls[0];
    expect(writeCall[0]).toMatch(/\.json$/);
    const parsed = JSON.parse(writeCall[1]);
    expect(parsed.title).toBe('Test Novel');
    expect(parsed.acts).toHaveLength(1);
  });

  it('handles missing book', async () => {
    mockDb.book.findUnique.mockResolvedValue(null);

    const argv = {
      _: ['export'], $0: 'proser-cli',
      bookId: 999, format: 'markdown', 'output-dir': './out', json: false,
    } as any;

    await exportCommand.handler(argv);

    expect((output.error as jest.Mock)).toHaveBeenCalledWith(
      expect.stringContaining('999')
    );
    expect(mockExit).toHaveBeenCalledWith(1);
  });

  it('outputs JSON confirmation when --json flag set', async () => {
    mockDb.book.findUnique.mockResolvedValue(makeBook());

    const argv = {
      _: ['export'], $0: 'proser-cli',
      bookId: 1, format: 'markdown', 'output-dir': './out', json: true,
    } as any;

    await exportCommand.handler(argv);

    expect((output.json as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        format: 'markdown',
      })
    );
  });
});
