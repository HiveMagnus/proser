/// <reference types="jest" />

const mockGenerateText = jest.fn();

jest.mock('../../lib/ai/vllm', () => ({
  VllmService: jest.fn().mockImplementation(() => ({
    generateText: mockGenerateText,
  })),
}));

jest.mock('../../prompts/service', () => ({
  interpolatePromptByKey: jest.fn().mockReturnValue('prompt-text'),
}));

jest.mock('../../cli/utils/extractJson', () => ({
  extractJson: jest.fn(),
}));

jest.mock('../../cli/utils/output', () => ({
  output: {
    success: jest.fn(),
    section: jest.fn(),
    table: jest.fn(),
  },
}));

jest.mock('../../lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { reviewChapterProse, printFindings } from '../../cli/pipeline/editorReview';
import { extractJson } from '../../cli/utils/extractJson';
import { output } from '../../cli/utils/output';

describe('editorReview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns parsed findings array from AI output', async () => {
    const findings = [
      {
        type: 'continuity',
        severity: 'warning',
        location: 'Scene 2',
        message: 'Inconsistent weather description',
        suggestion: 'Align with prior scene rainstorm',
      },
    ];
    mockGenerateText.mockResolvedValue('raw-ai-response');
    (extractJson as jest.Mock).mockReturnValue(findings);

    const result = await reviewChapterProse({
      title: 'Book',
      chapterNumber: 1,
      chapterTitle: 'Start',
      prose: 'text',
    });

    expect(result).toEqual(findings);
  });

  it('returns empty array when parsing fails or response is non-array', async () => {
    mockGenerateText.mockResolvedValue('bad-response');
    (extractJson as jest.Mock).mockReturnValue({ nope: true });

    const result = await reviewChapterProse({
      title: 'Book',
      chapterNumber: 1,
      chapterTitle: 'Start',
      prose: 'text',
    });

    expect(result).toEqual([]);
  });

  it('prints a success message for empty findings', () => {
    printFindings([], 'Chapter 1');
    expect((output.success as jest.Mock)).toHaveBeenCalledWith('Chapter 1: No issues found.');
  });
});
