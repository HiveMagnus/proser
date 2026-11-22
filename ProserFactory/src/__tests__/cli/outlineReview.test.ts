/// <reference types="jest" />

jest.mock('../../cli/utils/prompt', () => ({
  selectOption: jest.fn(),
  editInEditor: jest.fn(),
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

import { reviewChapterOutline } from '../../cli/pipeline/outlineReview';
import { selectOption, editInEditor } from '../../cli/utils/prompt';

const outline = {
  chapterId: 1,
  chapterNumber: 3,
  title: 'Broken Promise',
  summary: 'The hero finally confronts the mentor.',
  actNumber: 2,
};

describe('reviewChapterOutline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('auto-accepts when skipAll is true', async () => {
    const result = await reviewChapterOutline(outline, true);
    expect(result).toEqual({ result: { action: 'accept' }, skipAll: true });
    expect(selectOption).not.toHaveBeenCalled();
  });

  it('returns regenerate when regenerate is selected', async () => {
    (selectOption as jest.Mock).mockResolvedValue('regenerate');

    const result = await reviewChapterOutline(outline, false);

    expect(result).toEqual({ result: { action: 'regenerate' }, skipAll: false });
  });

  it('returns edited summary when edit is selected', async () => {
    (selectOption as jest.Mock).mockResolvedValue('edit');
    (editInEditor as jest.Mock).mockResolvedValue('  Updated summary  ');

    const result = await reviewChapterOutline(outline, false);

    expect(editInEditor).toHaveBeenCalled();
    expect(result).toEqual({
      result: { action: 'accept', editedSummary: 'Updated summary' },
      skipAll: false,
    });
  });
});
