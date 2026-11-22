import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlotThreadEvidencePicker } from '@/components/plot/plot-thread-evidence-picker';
const mocks = vi.hoisted(() => ({
  manifest: vi.fn(),
  structure: vi.fn(),
  passage: vi.fn(),
  add: vi.fn(),
}));
vi.mock('@/lib/document-api', () => ({
  getDocumentManifest: mocks.manifest,
  getDocumentScope: mocks.structure,
}));
vi.mock('@/lib/plot-thread-api', () => ({ plotRequest: mocks.passage }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.manifest.mockResolvedValue({
    revisionId: 'saved',
    scenes: [
      { sceneId: 1, chapterId: 1, sceneNumber: 1, revisionId: 'scene', contentHash: 'hash' },
    ],
  });
  mocks.structure.mockResolvedValue({
    bookRevisionId: 'saved',
    content: {
      acts: [{ id: 1, actNumber: 1 }],
      chapters: [{ id: 1, actId: 1, chapterNumber: 1 }],
      scenes: [{ id: 1, chapterId: 1, sceneNumber: 1, deletedAt: null }],
    },
  });
  mocks.passage.mockResolvedValue({
    sceneId: 1,
    bookRevisionId: 'saved',
    sceneRevisionId: 'scene',
    contentHash: 'hash',
    changes: [],
    paragraphs: [
      {
        offset: 0,
        paragraph: { id: 'paragraph', runs: [{ id: 'run', text: 'Exact saved clue.', style: {} }] },
      },
    ],
  });
});
describe('Saved Plot Threads evidence picker', () => {
  it('clears old passages and targets when a reload fails instead of offering stale evidence', async () => {
    const user = userEvent.setup();
    render(
      <PlotThreadEvidencePicker
        bookId="7"
        userId="owner"
        stage="setup"
        disabled={false}
        onAdd={mocks.add}
        onCancel={() => {}}
      />,
    );
    await screen.findByRole('option', { name: 'Act 1 · Chapter 1 · Scene 1' });
    await user.selectOptions(screen.getByLabelText('Scene'), '1');
    await user.click(await screen.findByRole('button', { name: 'Use paragraph 1' }));
    expect(screen.getByLabelText('Selected evidence excerpt')).toHaveTextContent(
      'Exact saved clue.',
    );
    mocks.manifest.mockRejectedValue(new Error('Saved scene registry unavailable'));
    await user.click(screen.getByRole('button', { name: 'Reload saved scenes' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('registry unavailable');
    expect(screen.queryByLabelText('Selected evidence excerpt')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Saved paragraph 1')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save linked excerpt' })).toBeDisabled();
    expect(mocks.add).not.toHaveBeenCalled();
  });
});
