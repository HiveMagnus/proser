import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { documentFromText } from '@hivemagnus/proser-editor';
import { DocumentReader, readerPreferenceKey } from '@/components/mobile/document-reader';
import { getDocumentManifest, getDocumentScope, getSceneDocument } from '@/lib/document-api';

const { replace, identity } = vi.hoisted(() => ({
  replace: vi.fn(),
  identity: { value: 'reader-one' as string | undefined },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { id: identity.value } }, status: 'authenticated' }),
}));
vi.mock('@/lib/document-api', () => ({
  getDocumentManifest: vi.fn(),
  getDocumentScope: vi.fn(),
  getSceneDocument: vi.fn(),
}));

describe('structured mobile reader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    identity.value = 'reader-one';
    vi.mocked(getDocumentManifest).mockResolvedValue({
      schemaVersion: 1,
      revisionId: 'book-revision',
      contentHash: 'book-hash',
      totals: { projection: 'final', wordCount: 300000, sceneCount: 6 },
      scenes: Array.from({ length: 6 }, (_, index) => ({
        sceneId: index + 1,
        chapterId: index < 4 ? 10 : 20,
        sceneNumber: index + 1,
        revisionId: `revision-${index + 1}`,
        contentHash: `hash-${index + 1}`,
        wordCount: 50000,
      })),
    });
    vi.mocked(getSceneDocument).mockImplementation(async (_bookId, sceneId) => {
      let sequence = 0;
      const document = documentFromText(
        `Saved scene ${sceneId}`,
        () => `${sceneId}-block-${++sequence}`,
      );
      return {
        sceneId: Number(sceneId),
        revisionId: `revision-${sceneId}`,
        bookRevisionId: 'book-revision',
        contentHash: `hash-${sceneId}`,
        document,
        projection: { text: `Saved scene ${sceneId}`, wordCount: 3, spans: [] },
      };
    });
  });
  it('loads a bounded book window and releases prior scene bodies on navigation', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<DocumentReader bookId="1" sceneId="1" />);
    await screen.findByText('Saved scene 1');
    await user.click(screen.getByRole('button', { name: 'Full book' }));
    await screen.findByText('Saved scene 3');
    expect(screen.queryByText('Saved scene 4')).not.toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(vi.mocked(getSceneDocument).mock.calls.every((call) => Number(call[1]) <= 3)).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(replace).toHaveBeenCalledWith('/m/read?bookId=1&sceneId=4');
    rerender(<DocumentReader bookId="1" sceneId="4" />);
    await screen.findByText('Saved scene 6');
    expect(screen.queryByText('Saved scene 1')).not.toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(3);
  });
  it('rejects bodies from a different revision without showing a mixed manuscript', async () => {
    const original = vi.mocked(getSceneDocument).getMockImplementation()!;
    vi.mocked(getSceneDocument).mockImplementation(async (...args) => ({
      ...(await original(...args)),
      revisionId: 'newer-revision',
    }));
    render(<DocumentReader bookId="1" sceneId="1" />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The book changed while loading');
    expect(
      within(alert).getByRole('button', { name: 'Reload saved revision' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Saved scene 1')).not.toBeInTheDocument();
  });
  it('hides the previous account document immediately when authentication changes', async () => {
    const { rerender } = render(<DocumentReader bookId="1" sceneId="1" />);
    await screen.findByText('Saved scene 1');
    vi.mocked(getDocumentManifest).mockReturnValue(new Promise(() => {}));
    identity.value = 'reader-two';
    rerender(<DocumentReader bookId="1" sceneId="1" />);
    expect(screen.queryByText('Saved scene 1')).not.toBeInTheDocument();
    await waitFor(() => expect(getDocumentManifest).toHaveBeenCalledTimes(2));
  });
  it('retains typography only for the same authenticated identity and never changes saved text', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<DocumentReader bookId="1" sceneId="1" />);
    await screen.findByText('Saved scene 1');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Reading font' }), 'Arial');
    expect(screen.getByRole('article')).toHaveStyle({ fontFamily: 'Arial' });
    expect(JSON.parse(localStorage.getItem(readerPreferenceKey('reader-one'))!).userId).toBe(
      'reader-one',
    );
    identity.value = 'reader-two';
    rerender(<DocumentReader bookId="1" sceneId="1" />);
    expect(screen.getByRole('combobox', { name: 'Reading font' })).toHaveValue('Georgia');
    await screen.findByText('Saved scene 1');
    identity.value = undefined;
    rerender(<DocumentReader bookId="1" sceneId="1" />);
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Reading font' })).toBeDisabled();
    identity.value = 'reader-one';
    rerender(<DocumentReader bookId="1" sceneId="1" />);
    await screen.findByText('Saved scene 1');
    expect(screen.getByRole('combobox', { name: 'Reading font' })).toHaveValue('Arial');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Reading size' })).toHaveAttribute(
      'aria-valuetext',
      '18 pixels',
    );
  });
  it('rejects mismatched or invalid saved typography and does not silently substitute a missing scene', async () => {
    localStorage.setItem(
      readerPreferenceKey('reader-one'),
      JSON.stringify({ schemaVersion: 1, userId: 'reader-two', font: 'Arial', size: 28 }),
    );
    render(<DocumentReader bookId="1" sceneId="999" />);
    await screen.findByText('This saved scene is unavailable. Choose another scene in the studio.');
    expect(screen.getByRole('combobox', { name: 'Reading font' })).toHaveValue('Georgia');
    expect(getSceneDocument).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Next scene' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous scene' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Full book' }));
    expect(getSceneDocument).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });
  it('resolves named heading styles from the exact saved layout revision', async () => {
    const original = vi.mocked(getDocumentManifest).getMockImplementation()!;
    vi.mocked(getDocumentManifest).mockImplementation(async (...args) => ({
      ...(await original(...args)),
      scopes: {
        layout: { revisionId: 'layout-revision', contentHash: 'layout-hash' },
        structure: { revisionId: 'structure', contentHash: 'structure-hash' },
        canon: { revisionId: 'canon', contentHash: 'canon-hash' },
      },
    }));
    const document = documentFromText('Named heading', () => crypto.randomUUID());
    const block = document.blocks[0]!;
    if (block.type !== 'paragraph') throw new Error('fixture');
    block.style.name = 'ChapterOpening';
    vi.mocked(getSceneDocument).mockResolvedValue({
      sceneId: 1,
      revisionId: 'revision-1',
      bookRevisionId: 'book-revision',
      contentHash: 'hash-1',
      document,
      projection: { text: 'Named heading', wordCount: 2, spans: [] },
    });
    vi.mocked(getDocumentScope).mockResolvedValue({
      revisionId: 'layout-revision',
      bookRevisionId: 'book-revision',
      contentHash: 'layout-hash',
      content: {
        schemaVersion: 1,
        book: document.layout,
        chapters: {},
        frontMatter: [],
        backMatter: [],
        styles: { paragraph: { ChapterOpening: { heading: 2 } }, text: {} },
      },
    });
    const frozen = JSON.stringify(document);
    render(<DocumentReader bookId="1" sceneId="1" />);
    await screen.findByRole('heading', { level: 2, name: 'Named heading' });
    expect(JSON.stringify(document)).toBe(frozen);
    expect(getDocumentScope).toHaveBeenCalledWith('1', 'layout', expect.any(AbortSignal));
  });
  it('refuses to render a scene against styles from a newer layout revision', async () => {
    const original = vi.mocked(getDocumentManifest).getMockImplementation()!;
    vi.mocked(getDocumentManifest).mockImplementation(async (...args) => ({
      ...(await original(...args)),
      scopes: {
        layout: { revisionId: 'saved-layout', contentHash: 'saved-layout-hash' },
        structure: { revisionId: 'structure', contentHash: 'structure-hash' },
        canon: { revisionId: 'canon', contentHash: 'canon-hash' },
      },
    }));
    const document = documentFromText('Saved scene 1', () => crypto.randomUUID());
    vi.mocked(getDocumentScope).mockResolvedValue({
      revisionId: 'newer-layout',
      contentHash: 'newer-layout-hash',
      bookRevisionId: 'newer-book',
      content: {
        schemaVersion: 1,
        book: document.layout,
        chapters: {},
        frontMatter: [],
        backMatter: [],
        styles: { paragraph: {}, text: {} },
      },
    });
    render(<DocumentReader bookId="1" sceneId="1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The book layout changed');
    expect(getSceneDocument).not.toHaveBeenCalled();
  });
});
