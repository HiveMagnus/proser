import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultLayout, type BookLayoutSnapshot } from '@cheftaco/proser-contracts';
import { DocumentLayoutSettings } from '@/components/editor/document-layout-settings';
import { editLayoutStoryParagraph, reconcileLayoutSettings } from '@/lib/document-layout-editing';
import * as api from '@/lib/document-api';
import * as journal from '@/lib/document-layout-journal';
vi.mock('@/lib/document-api', async (original) => ({
  ...(await original<typeof import('@/lib/document-api')>()),
  getDocumentScope: vi.fn(),
  getDocumentLayoutRevision: vi.fn(),
  saveDocumentLayout: vi.fn(),
  recoverDocumentLayout: vi.fn(),
}));
vi.mock('@/lib/document-layout-history', async (original) => ({
  ...(await original<typeof import('@/lib/document-layout-history')>()),
  readLayoutHistory: vi.fn(async () => undefined),
  writeLayoutHistory: vi.fn(async () => undefined),
}));
vi.mock('@/lib/document-layout-journal', async (original) => ({
  ...(await original<typeof import('@/lib/document-layout-journal')>()),
  readLayoutDraft: vi.fn(),
  writeLayoutDraft: vi.fn(),
  deleteLayoutDraft: vi.fn(),
}));
const layout = (): BookLayoutSnapshot => ({
  schemaVersion: 1,
  book: defaultLayout(),
  chapters: {},
  frontMatter: [],
  backMatter: [],
  styles: { text: {}, paragraph: {} },
});
const source = () => ({
  revisionId: 'layout-base',
  bookRevisionId: 'book-base',
  contentHash: 'source-hash',
  content: layout(),
});
const receipt = (operationId: string): api.SaveLayoutReceipt => ({
  kind: 'catalog',
  operationId,
  revisionId: 'book-saved',
  contentHash: 'fixture-hash',
  status: 'completed',
  manifest: {
    scopes: { layout: { revisionId: 'layout-saved', contentHash: 'saved-hash' } },
  } as api.SaveLayoutReceipt['manifest'],
  result: { changedScope: 'layout' },
});
describe('revision-bound layout settings', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.getDocumentScope).mockResolvedValue(source());
    vi.mocked(api.getDocumentLayoutRevision).mockImplementation(async () => ({
      revisionId: 'layout-saved',
      contentHash: 'saved-hash',
      content: vi.mocked(api.saveDocumentLayout).mock.calls.at(-1)?.[1].layout ?? layout(),
    }));
    vi.mocked(journal.readLayoutDraft).mockResolvedValue(undefined);
    vi.mocked(journal.writeLayoutDraft).mockResolvedValue(undefined);
    vi.mocked(journal.deleteLayoutDraft).mockResolvedValue(undefined);
    vi.mocked(api.saveDocumentLayout).mockImplementation(async (_book, body) =>
      receipt(body.operationId),
    );
  });
  it('undoes a committed layout through its exact owned immutable revision proof', async () => {
    const user = userEvent.setup();
    render(<DocumentLayoutSettings userId="owner" bookId="1" />);
    await screen.findByText('Saved layout.');
    await user.selectOptions(screen.getByLabelText('Default font'), 'Liberation Serif');
    await user.click(screen.getByRole('button', { name: 'Save layout changes' }));
    await waitFor(() => expect(api.saveDocumentLayout).toHaveBeenCalledTimes(1));
    await screen.findByText('Layout saved by Factory.');
    await user.click(screen.getByRole('button', { name: 'Undo layout edit' }));
    await waitFor(() => expect(api.saveDocumentLayout).toHaveBeenCalledTimes(2));
    const request = vi.mocked(api.saveDocumentLayout).mock.calls[1]![1];
    expect(request.restoreFromRevisionId).toBe('layout-base');
    expect(request.layout).toEqual(layout());
    expect(request.expectedRevisionId).toBe('book-saved');
    expect(request.expectedScopes.layout).toBe('layout-saved');
    expect(api.getDocumentLayoutRevision).toHaveBeenCalledWith('1', 'layout-saved');
  });
  it('retains pending recovery until its immutable saved bytes are fetched and verified', async () => {
    vi.mocked(api.getDocumentLayoutRevision).mockRejectedValue(
      new TypeError('Revision fetch lost'),
    );
    const user = userEvent.setup();
    render(<DocumentLayoutSettings userId="owner" bookId="1" />);
    await screen.findByText('Saved layout.');
    await user.selectOptions(screen.getByLabelText('Default font'), 'Liberation Serif');
    await user.click(screen.getByRole('button', { name: 'Save layout changes' }));
    await screen.findByText('Revision fetch lost');
    expect(journal.deleteLayoutDraft).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Recover layout receipt' })).toBeTruthy();
  });
  it('creates named front matter without changing existing section identities or body layout', async () => {
    const user = userEvent.setup();
    render(<DocumentLayoutSettings userId="owner" bookId="1" />);
    await screen.findByText('Saved layout.');
    await user.type(screen.getByLabelText('Story name'), 'Dedication');
    await user.click(screen.getByRole('button', { name: 'Add front matter story' }));
    await user.click(screen.getByRole('button', { name: 'Save layout changes' }));
    await screen.findByText('Layout saved by Factory.');
    const request = vi.mocked(api.saveDocumentLayout).mock.calls[0]![1];
    expect(request.layout.frontMatter[0]).toMatchObject({
      name: 'Dedication',
      document: { schemaVersion: 1, comments: [], changes: [] },
    });
    expect(request.layout.book).toEqual(defaultLayout());
    expect(request.layout.backMatter).toEqual([]);
  });
  it('saves only chapter layout with book/layout revision preconditions and journals before dispatch', async () => {
    const user = userEvent.setup();
    render(<DocumentLayoutSettings userId="owner" bookId="1" chapterId={2} />);
    await screen.findByText('Saved layout.');
    await user.selectOptions(screen.getByLabelText('Layout scope'), 'chapter');
    await user.selectOptions(screen.getByLabelText('Default font'), 'Liberation Serif');
    await user.click(screen.getByRole('button', { name: 'Save layout changes' }));
    await screen.findByText('Layout saved by Factory.');
    const request = vi.mocked(api.saveDocumentLayout).mock.calls[0]![1];
    expect(request.expectedRevisionId).toBe('book-base');
    expect(request.expectedScopes).toEqual({ layout: 'layout-base' });
    expect(request.layout.book).toEqual(defaultLayout());
    expect(request.layout.chapters['2']!.font).toBe('Liberation Serif');
    expect(vi.mocked(journal.writeLayoutDraft).mock.invocationCallOrder.at(-1)).toBeLessThan(
      vi.mocked(api.saveDocumentLayout).mock.invocationCallOrder[0]!,
    );
    expect(journal.deleteLayoutDraft).toHaveBeenCalledWith('owner', '1', request.operationId);
  });
  it('a lost acknowledgement requires exact receipt recovery before a permitted exact retry', async () => {
    const user = userEvent.setup();
    vi.mocked(api.saveDocumentLayout).mockRejectedValueOnce(new Error('Connection lost.'));
    vi.mocked(api.recoverDocumentLayout).mockRejectedValueOnce(
      new api.DocumentRequestError('Not found', 404),
    );
    render(<DocumentLayoutSettings userId="owner" bookId="1" />);
    await screen.findByText('Saved layout.');
    await user.click(screen.getByLabelText('Page numbers'));
    await user.click(screen.getByRole('button', { name: 'Save layout changes' }));
    await screen.findByText('Connection lost.');
    expect(screen.queryByRole('button', { name: 'Retry exact layout save' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Recover layout receipt' }));
    await screen.findByRole('button', { name: 'Retry exact layout save' });
    const exact = vi.mocked(api.saveDocumentLayout).mock.calls[0]![1];
    await user.click(screen.getByRole('button', { name: 'Retry exact layout save' }));
    await screen.findByText('Layout saved by Factory.');
    expect(vi.mocked(api.saveDocumentLayout).mock.calls[1]![1]).toEqual(exact);
  });
  it('account changes remount recovery and suppress a late prior-account response', async () => {
    let resolve!: (value: Awaited<ReturnType<typeof journal.readLayoutDraft>>) => void;
    vi.mocked(journal.readLayoutDraft).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = render(<DocumentLayoutSettings userId="first" bookId="1" />);
    view.rerender(<DocumentLayoutSettings userId="second" bookId="1" />);
    await screen.findByText('Saved layout.');
    resolve({
      schemaVersion: 1,
      userId: 'first',
      bookId: '1',
      journalRevision: 'retained-version',
      baseRevisionId: 'old',
      baseLayoutRevisionId: 'old-layout',
      updatedAt: Date.now(),
      layout: layout(),
      baseLayout: layout(),
    });
    await waitFor(() => expect(journal.readLayoutDraft).toHaveBeenCalledWith('second', '1'));
    expect(screen.queryByLabelText('Layout draft recovery')).toBeNull();
  });
  it('does not dispatch when recovery storage cannot retain the exact request', async () => {
    const user = userEvent.setup();
    vi.mocked(journal.writeLayoutDraft).mockRejectedValue(new Error('Storage unavailable.'));
    render(<DocumentLayoutSettings userId="owner" bookId="1" />);
    await screen.findByText('Saved layout.');
    await user.click(screen.getByLabelText('Page numbers'));
    await screen.findByText('Storage unavailable.');
    await user.click(screen.getByRole('button', { name: 'Save layout changes' }));
    await waitFor(() => expect(api.saveDocumentLayout).not.toHaveBeenCalled());
  });
  it('story edits preserve stable style runs and reject ambiguous or review-bound replacements', () => {
    const paragraph = {
      type: 'paragraph' as const,
      id: 'header',
      style: { alignment: 'center' as const },
      runs: [{ id: 'run', text: 'A header.', style: { bold: true } }],
    };
    const edited = editLayoutStoryParagraph(paragraph, 'A vivid header.');
    expect(edited.id).toBe(paragraph.id);
    expect(edited.runs.every((run) => run.style.bold)).toBe(true);
    expect(edited.runs.map((run) => run.text).join('')).toBe('A vivid header.');
    expect(() =>
      editLayoutStoryParagraph(
        { ...paragraph, boundaryChangeId: 'pending-mark' },
        'A different header.',
      ),
    ).toThrow('Resolve');
    expect(() =>
      editLayoutStoryParagraph(
        {
          ...paragraph,
          runs: [
            { id: 'bold', text: 'A ', style: { bold: true } },
            { id: 'italic', text: 'header.', style: { italic: true } },
          ],
        },
        'Other text.',
      ),
    ).toThrow();
  });
  it('layout reconciliation preserves remote stories and identifies overlapping settings for explicit choice', () => {
    const base = layout();
    const local = structuredClone(base);
    const saved = structuredClone(base);
    local.book.font = 'Liberation Serif';
    saved.book.pageNumbers = false;
    saved.backMatter = [
      {
        id: 'new-story',
        name: 'Afterword',
        document: {
          schemaVersion: 1,
          blocks: [],
          layout: defaultLayout(),
          changes: [],
          comments: [],
        },
      },
    ];
    const proposal = reconcileLayoutSettings(base, local, saved);
    expect(proposal.conflicts).toEqual([]);
    expect(proposal.layout.book.font).toBe('Liberation Serif');
    expect(proposal.layout.book.pageNumbers).toBe(false);
    expect(proposal.layout.backMatter).toEqual(saved.backMatter);
    saved.book.font = 'DejaVu Serif';
    expect(reconcileLayoutSettings(base, local, saved).conflicts).toEqual(['book.font']);
    expect(base.book.font).toBe('Georgia');
  });
  it('a stale save can reconcile only after receipt recovery and an explicit reviewed merge', async () => {
    const user = userEvent.setup();
    vi.mocked(api.saveDocumentLayout).mockRejectedValueOnce(
      new api.DocumentRequestError('The book changed.', 412),
    );
    vi.mocked(api.recoverDocumentLayout).mockRejectedValue(
      new api.DocumentRequestError('No receipt', 404),
    );
    render(<DocumentLayoutSettings userId="owner" bookId="1" />);
    await screen.findByText('Saved layout.');
    await user.click(screen.getByLabelText('Page numbers'));
    await user.click(screen.getByRole('button', { name: 'Save layout changes' }));
    await screen.findByText('The book changed.');
    await user.click(screen.getByRole('button', { name: 'Recover layout receipt' }));
    const remote = source();
    remote.bookRevisionId = 'current-book';
    remote.revisionId = 'current-layout';
    remote.content.book.font = 'Liberation Serif';
    vi.mocked(api.getDocumentScope).mockResolvedValue(remote);
    await user.click(await screen.findByRole('button', { name: 'Compare saved layout' }));
    await user.click(await screen.findByRole('button', { name: 'Use reviewed layout merge' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save layout changes' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Save layout changes' }));
    await screen.findByText('Layout saved by Factory.');
    const next = vi.mocked(api.saveDocumentLayout).mock.calls[1]![1];
    expect(next.expectedRevisionId).toBe('current-book');
    expect(next.expectedScopes.layout).toBe('current-layout');
    expect(next.layout.book.font).toBe('Liberation Serif');
    expect(next.layout.book.pageNumbers).toBe(false);
    expect(next.operationId).not.toBe(
      vi.mocked(api.saveDocumentLayout).mock.calls[0]![1].operationId,
    );
  });
});

describe('owned full header/footer stories', () => {
  it('explicitly upgrades the chosen chapter story without replacing body or inherited book stories', async () => {
    const { ownHeaderFooterStory, headerFooterForChapter } =
      await import('@/lib/document-layout-editing');
    const original = layout();
    original.book.header = [
      {
        type: 'paragraph',
        id: 'book-header',
        style: { heading: 1 },
        runs: [{ id: 'book-run', text: 'Book heading', style: { italic: true } }],
      },
    ];
    original.chapters['2'] = {
      ...structuredClone(original.book),
      footer: [
        {
          type: 'paragraph',
          id: 'footer',
          style: {},
          runs: [{ id: 'footer-run', text: 'Chapter footer', style: { bold: true } }],
        },
      ],
    };
    let sequence = 0;
    const bookOwned = ownHeaderFooterStory(
      original,
      'header',
      undefined,
      () => `owned-${++sequence}`,
    );
    const chapterOwned = ownHeaderFooterStory(bookOwned, 'footer', 2, () => `owned-${++sequence}`);
    expect(original.book.header).toHaveLength(1);
    expect(chapterOwned.book.header).toEqual([]);
    expect(chapterOwned.chapters['2']!.footer).toEqual([]);
    expect(chapterOwned.headerFooterStories![1]!.document.blocks).toEqual(
      original.chapters['2']!.footer,
    );
    expect(chapterOwned.headerFooterStories![1]!.document.layout.header).toEqual([]);
    expect(headerFooterForChapter(chapterOwned, 2).header!.blocks).toEqual(original.book.header);
    expect(headerFooterForChapter(chapterOwned, 2).footer!.blocks).toEqual(
      original.chapters['2']!.footer,
    );
    expect(() => ownHeaderFooterStory(chapterOwned, 'footer', 2)).toThrow('already owns');
  });
});
