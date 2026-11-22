import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultLayout,
  type DocumentPassage,
  type PassageScopeReceipt,
  type PassageScopeTransfer,
} from '@cheftaco/proser-contracts';
import { DocumentPassageTransfers } from '@/components/editor/document-passage-transfers';
import type { PassageTypedSession } from '@/lib/document-passage-typed-session';
import type { PassageScopeJournal } from '@/lib/document-passage-scope-journal';
import * as api from '@/lib/document-api';
const storage = vi.hoisted(() => ({
  row: undefined as PassageScopeJournal | undefined,
  writes: [] as PassageScopeJournal[],
}));
vi.mock('@/lib/document-passage-scope-journal', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/document-passage-scope-journal')>();
  return {
    ...original,
    readPassageScopeJournal: vi.fn(async () => storage.row),
    writePassageScopeJournal: vi.fn(async (row: PassageScopeJournal) => {
      storage.row = structuredClone(row);
      storage.writes.push(structuredClone(row));
    }),
  };
});
vi.mock('@/lib/document-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/document-api')>()),
  requestDocumentResource: vi.fn(),
}));
function passage(sceneId: number, revision = 'before'): DocumentPassage {
  const blockId = `paragraph-${sceneId}`,
    placement = {
      before: {
        neighborId: blockId,
        neighborHash: '1'.repeat(64),
        containerHash: '2'.repeat(64),
        side: 'before' as const,
      },
      after: {
        neighborId: blockId,
        neighborHash: '1'.repeat(64),
        containerHash: '2'.repeat(64),
        side: 'after' as const,
      },
    };
  return {
    schemaVersion: 1,
    bookRevisionId: `book-${revision}`,
    sceneId,
    sceneRevisionId: `scene-${sceneId}-${revision}`,
    contentHash: '3'.repeat(64),
    projection: 'final',
    sourceFrame: {
      bookId: 1,
      actId: 2,
      chapterId: 3,
      sceneId,
      bookRevisionId: `book-${revision}`,
      sceneRevisionId: `scene-${sceneId}-${revision}`,
      bookContentHash: '4'.repeat(64),
      sceneContentHash: '3'.repeat(64),
      qualifiedMembershipHash: '5'.repeat(64),
      structureScope: { revisionId: 'structure', contentHash: '6'.repeat(64) },
      layoutScope: { revisionId: 'layout', contentHash: '7'.repeat(64) },
      effectiveStyleLayoutHash: '8'.repeat(64),
      projection: 'final',
    },
    cursor: { item: 0, paragraph: 0, offset: 0 },
    windowHash: '9'.repeat(64),
    layout: defaultLayout(),
    changes: [],
    images: [],
    omitted: { paragraphs: 0, objects: 0, comments: 0, changes: 0 },
    paragraphs: [
      {
        paragraph: {
          type: 'paragraph',
          id: blockId,
          style: {},
          runs: [{ id: `run-${sceneId}`, text: 'bounded fragment', style: {} }],
        },
        ordinal: 0,
        offset: 0,
        length: 1500000,
        continuedBefore: false,
        continuedAfter: true,
        paragraphHash: 'a'.repeat(64),
        containerHash: 'b'.repeat(64),
        runs: [
          {
            runId: `run-${sceneId}`,
            sourceHash: 'c'.repeat(64),
            from: 0,
            to: 16,
            sourceLength: 1500000,
          },
        ],
      },
    ],
    items: [{ type: 'paragraph', paragraphIndex: 0, blockOrdinal: 0, placement }],
  };
}
function harness() {
  const first = passage(4),
    second = passage(5);
  const make = (value: DocumentPassage) => ({
    getSnapshot: () => ({ state: 'saved', passage: value }),
    flush: vi.fn(async () => value),
    adoptScopedPassage: vi.fn(),
    load: vi.fn(),
  });
  const left = make(first),
    right = make(second),
    sessions = new Map([
      [4, left],
      [5, right],
    ]) as unknown as Map<number, PassageTypedSession>;
  const references = [first, second].map((value) => ({
    sceneId: value.sceneId,
    chapterId: 3,
    sceneNumber: value.sceneId - 3,
    revisionId: value.sceneRevisionId,
    contentHash: value.contentHash,
    wordCount: 300000,
  }));
  return { left, right, sessions, references };
}
function receipt(request: PassageScopeTransfer): PassageScopeReceipt {
  const passages = [passage(4, 'after'), passage(5, 'after')];
  return {
    kind: 'catalog',
    operationId: request.operationId,
    revisionId: 'book-after',
    contentHash: '4'.repeat(64),
    status: 'completed',
    sceneReferences: passages.map((value) => ({
      sceneId: value.sceneId,
      chapterId: 3,
      sceneNumber: value.sceneId - 3,
      revisionId: value.sceneRevisionId,
      contentHash: value.contentHash,
      wordCount: 300000,
    })),
    result: { passages, sceneIds: [4, 5], sourceBookRevisionId: request.expectedRevisionId },
  };
}
beforeEach(() => {
  storage.row = undefined;
  storage.writes = [];
  vi.mocked(api.requestDocumentResource).mockReset();
});
describe('bounded atomic scene transfer controls', () => {
  it.each([
    { run: 256, continuedBefore: false },
    { run: 0, continuedBefore: true },
  ])(
    'rejects a middle destination excerpt after an earlier valid selection: %j',
    async (middle) => {
      const { sessions, references, left, right } = harness();
      const source = passage(4),
        destination = passage(5);
      source.paragraphs[0]!.continuedAfter = false;
      destination.paragraphs[0]!.continuedAfter = false;
      left.getSnapshot = () => ({ state: 'saved', passage: source });
      right.getSnapshot = () => ({ state: 'saved', passage: destination });
      render(
        <DocumentPassageTransfers
          userId="owner"
          bookId="1"
          references={references}
          sessions={sessions}
          revision={0}
          disabled={false}
          onDirtyChange={() => {}}
        />,
      );
      const preview = screen.getByRole('region', { name: 'Adjacent saved scene excerpts' });
      const runs = preview.querySelectorAll('[data-run-id]');
      const range = document.createRange();
      range.setStart(runs[0]!, 0);
      range.setEnd(runs[1]!, runs[1]!.childNodes.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      const apply = screen.getByRole('button', { name: 'Apply multipart text atomically' });
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Load source scene end' })).toBeEnabled(),
      );
      fireEvent.mouseUp(preview);
      expect(screen.getByText('2 qualified styled ranges selected.')).toBeVisible();
      expect(apply).toBeEnabled();
      destination.cursor.run = middle.run;
      destination.paragraphs[0]!.continuedBefore = middle.continuedBefore;
      fireEvent.mouseUp(preview);
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Load the adjacent source end and destination beginning before selecting.',
      );
      expect(screen.getByText('0 qualified styled ranges selected.')).toBeVisible();
      expect(apply).toBeDisabled();
      expect(api.requestDocumentResource).not.toHaveBeenCalled();
      selection.removeAllRanges();
    },
  );
  it('discloses a midword fragment and reaches the exact Unicode ending through bounded cursors', async () => {
    const { sessions, references, left } = harness();
    const first = passage(4);
    const next = { item: 0, paragraph: 0, offset: 8000, run: 0 };
    first.paragraphs[0]!.paragraph.runs[0]!.text = `${'a'.repeat(7991)}*Connectio`;
    first.paragraphs[0]!.runs[0]!.to = 8000;
    first.next = next;
    let current = first;
    left.getSnapshot = () => ({ state: 'saved', passage: current });
    left.flush.mockImplementation(async () => current);
    left.load.mockImplementation(async () => {
      expect(left.flush).toHaveBeenCalled();
      current = passage(4);
      current.cursor = next;
      current.paragraphs[0]!.offset = 8000;
      current.paragraphs[0]!.continuedBefore = true;
      current.paragraphs[0]!.continuedAfter = false;
      current.paragraphs[0]!.paragraph.runs[0]!.text = 'n — ending 😀 e\u0301 *Connection';
    });
    const user = userEvent.setup();
    render(
      <DocumentPassageTransfers
        userId="owner"
        bookId="1"
        references={references}
        sessions={sessions}
        revision={0}
        disabled={false}
        onDirtyChange={() => {}}
      />,
    );
    const preview = screen.getByRole('region', { name: 'Adjacent saved scene excerpts' });
    expect(preview).toHaveAttribute('tabindex', '0');
    expect(preview).toHaveClass('max-h-80', 'overflow-auto', 'overscroll-contain');
    expect(within(preview).getByText('Source scene continues in the next excerpt.')).toBeVisible();
    expect(within(preview).queryByText('End of source scene.')).not.toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Next source excerpt' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(left.load).toHaveBeenCalledWith({
      bookRevisionId: 'book-before',
      cursor: next,
      maxCharacters: 8000,
      maxParagraphs: 24,
      maxRuns: 256,
      projection: 'final',
    });
    await waitFor(() => expect(within(preview).getByText('End of source scene.')).toBeVisible());
    expect(preview).toHaveTextContent('n — ending 😀 e\u0301 *Connection');
    expect(preview).toHaveTextContent('Earlier scene text precedes this excerpt.');
    expect(button).toBeDisabled();
    expect(api.requestDocumentResource).not.toHaveBeenCalled();
  });
  it('loads the terminal excerpt after flushing and keeps unresolved work in place', async () => {
    const { sessions, references, left, right } = harness();
    const user = userEvent.setup();
    render(
      <DocumentPassageTransfers
        userId="owner"
        bookId="1"
        references={references}
        sessions={sessions}
        revision={0}
        disabled={false}
        onDirtyChange={() => {}}
      />,
    );
    const button = screen.getByRole('button', { name: 'Load source scene end' });
    await waitFor(() => expect(button).toBeEnabled());
    left.flush.mockRejectedValueOnce(new Error('Recover this save first.'));
    await user.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('Recover this save first.');
    expect(left.load).not.toHaveBeenCalled();
    await user.click(button);
    expect(left.load).toHaveBeenCalledWith({
      edge: 'last',
      bookRevisionId: 'book-before',
      maxCharacters: 8000,
      maxParagraphs: 24,
      maxRuns: 256,
      projection: 'final',
    });
    await user.click(screen.getByRole('button', { name: 'Load destination beginning' }));
    expect(right.flush).toHaveBeenCalled();
    expect(right.load).toHaveBeenCalledWith({
      cursor: { item: 0, paragraph: 0, offset: 0 },
      bookRevisionId: 'book-before',
      maxCharacters: 8000,
      maxParagraphs: 24,
      maxRuns: 256,
      projection: 'final',
    });
  });
  it('follows run-bound continuation without guessing an offset from the visible quotation', async () => {
    const { sessions, references, left } = harness();
    const fragment = passage(4);
    fragment.next = { item: 0, paragraph: 0, offset: 0, run: 256 };
    left.getSnapshot = () => ({ state: 'saved', passage: fragment });
    left.flush.mockResolvedValue(fragment);
    const user = userEvent.setup();
    render(
      <DocumentPassageTransfers
        userId="owner"
        bookId="1"
        references={references}
        sessions={sessions}
        revision={0}
        disabled={false}
        onDirtyChange={() => {}}
      />,
    );
    const button = screen.getByRole('button', { name: 'Next source excerpt' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(left.load).toHaveBeenCalledWith(expect.objectContaining({ cursor: fragment.next }));
  });
  it('surfaces a passage load failure without reporting that the previous excerpt reached the end', async () => {
    const { sessions, references, left } = harness();
    const fragment = passage(4);
    fragment.next = { item: 0, paragraph: 0, offset: 16 };
    let failed = false;
    left.getSnapshot = () => ({
      state: failed ? 'failed' : 'saved',
      passage: fragment,
      error: failed ? 'The saved excerpt could not be loaded.' : undefined,
    });
    left.flush.mockResolvedValue(fragment);
    left.load.mockImplementation(async () => {
      failed = true;
    });
    const user = userEvent.setup();
    render(
      <DocumentPassageTransfers
        userId="owner"
        bookId="1"
        references={references}
        sessions={sessions}
        revision={0}
        disabled={false}
        onDirtyChange={() => {}}
      />,
    );
    const button = screen.getByRole('button', { name: 'Next source excerpt' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The saved excerpt could not be loaded.',
    );
    const preview = screen.getByRole('region', { name: 'Adjacent saved scene excerpts' });
    expect(preview).toHaveTextContent('bounded fragment');
    expect(within(preview).queryByText('End of source scene.')).not.toBeInTheDocument();
  });
  it('persists exact complete-block identity before dispatch and adopts both sparse scene acknowledgements', async () => {
    const { sessions, references, left, right } = harness();
    vi.mocked(api.requestDocumentResource).mockImplementation(async (_path, input) => {
      const request = JSON.parse(String(input?.body)) as PassageScopeTransfer;
      expect(storage.row?.pending?.request).toEqual(request);
      return receipt(request) as never;
    });
    const user = userEvent.setup();
    render(
      <DocumentPassageTransfers
        userId="owner"
        bookId="1"
        references={references}
        sessions={sessions}
        revision={0}
        disabled={false}
        onDirtyChange={() => {}}
      />,
    );
    const select = screen.getByRole('listbox', { name: 'Whole blocks to transfer' });
    await waitFor(() => expect(select).toBeEnabled());
    await user.selectOptions(select, ['paragraph-4']);
    await user.click(screen.getByRole('button', { name: 'Move whole selected blocks atomically' }));
    await waitFor(() => expect(left.adoptScopedPassage).toHaveBeenCalled());
    expect(right.adoptScopedPassage).toHaveBeenCalled();
    expect(storage.row?.pending).toBeUndefined();
    expect(storage.row?.history).toEqual([
      {
        beforeBookRevisionId: 'book-before',
        afterBookRevisionId: 'book-after',
        sceneIds: [4, 5],
        sceneRevisions: { '4': 'scene-4-after', '5': 'scene-5-after' },
      },
    ]);
    const request = JSON.parse(
      String(vi.mocked(api.requestDocumentResource).mock.calls[0]![1]?.body),
    );
    expect(request.blocks).toEqual([{ blockId: 'paragraph-4', sourceHash: '1'.repeat(64) }]);
    expect(JSON.stringify(request)).not.toContain('bounded fragment');
    expect(request.source.expectedSceneRevisionId).toBe('scene-4-before');
    expect(request.destination.expectedSceneRevisionId).toBe('scene-5-before');
  });
  it('refuses complete scope undo after newer affected-scene work', async () => {
    const { sessions, references, left } = harness();
    vi.mocked(api.requestDocumentResource).mockImplementation(
      async (_path, input) => receipt(JSON.parse(String(input?.body))) as never,
    );
    const user = userEvent.setup();
    render(
      <DocumentPassageTransfers
        userId="owner"
        bookId="1"
        references={references}
        sessions={sessions}
        revision={0}
        disabled={false}
        onDirtyChange={() => {}}
      />,
    );
    const select = screen.getByRole('listbox', { name: 'Whole blocks to transfer' });
    await waitFor(() => expect(select).toBeEnabled());
    await user.selectOptions(select, ['paragraph-4']);
    await user.click(screen.getByRole('button', { name: 'Move whole selected blocks atomically' }));
    await waitFor(() => expect(left.adoptScopedPassage).toHaveBeenCalled());
    vi.mocked(left.flush).mockResolvedValue(passage(4, 'newer'));
    await user.click(screen.getByRole('button', { name: 'Undo last scene transfer' }));
    await screen.findByText(/Newer scene work supersedes this window operation/);
    expect(api.requestDocumentResource).toHaveBeenCalledTimes(1);
    expect(storage.row?.history).toHaveLength(1);
  });
  it('retains an unknown transfer and checks the original receipt before offering an exact retry', async () => {
    const { sessions, references, left } = harness();
    vi.mocked(api.requestDocumentResource).mockRejectedValueOnce(new Error('Lost response'));
    const user = userEvent.setup();
    render(
      <DocumentPassageTransfers
        userId="owner"
        bookId="1"
        references={references}
        sessions={sessions}
        revision={0}
        disabled={false}
        onDirtyChange={() => {}}
      />,
    );
    const select = screen.getByRole('listbox', { name: 'Whole blocks to transfer' });
    await waitFor(() => expect(select).toBeEnabled());
    await user.selectOptions(select, ['paragraph-4']);
    await user.click(screen.getByRole('button', { name: 'Move whole selected blocks atomically' }));
    await screen.findByText('Lost response');
    expect(left.adoptScopedPassage).not.toHaveBeenCalled();
    const pending = storage.row?.pending;
    if (pending?.kind !== 'transfer') throw new Error('pending transfer');
    const request = pending.request;
    vi.mocked(api.requestDocumentResource).mockResolvedValueOnce(receipt(request));
    await user.click(screen.getByRole('button', { name: 'Check original transfer receipt' }));
    await waitFor(() => expect(left.adoptScopedPassage).toHaveBeenCalled());
    expect(api.requestDocumentResource).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.requestDocumentResource).mock.calls[1]![0]).toContain(
      `/document-operations/${request.operationId}`,
    );
    expect(storage.row?.pending).toBeUndefined();
  });
});
