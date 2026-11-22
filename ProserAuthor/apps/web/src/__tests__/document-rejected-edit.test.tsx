import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { documentFromText } from '@cheftaco/proser-editor';
import { useRejectedDocumentEdit } from '@/hooks/use-rejected-document-edit';
import * as journal from '@/lib/document-rejected-edits';
vi.mock('@/lib/document-rejected-edits', () => ({
  readRejectedDocumentEdit: vi.fn(),
  writeRejectedDocumentEdit: vi.fn(),
  deleteRejectedDocumentEdit: vi.fn(),
}));
const source = {
  revisionId: 'scene-source',
  contentHash: 'a'.repeat(64),
  document: documentFromText('Canonical unchanged', () => crypto.randomUUID()),
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(journal.readRejectedDocumentEdit).mockResolvedValue(undefined);
  vi.mocked(journal.writeRejectedDocumentEdit).mockResolvedValue(undefined);
  vi.mocked(journal.deleteRejectedDocumentEdit).mockResolvedValue(undefined);
});
describe('unsupported native draft quarantine', () => {
  it('retains the exact raw edit by authenticated scope and requires explicit discard', async () => {
    const hook = renderHook(() => useRejectedDocumentEdit('user-a', '1', 'scene', '2', source));
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    const nativeValue = {
      data: {
        main: [
          {
            type: 'table',
            trList: [{ tdList: [{ colspan: 2, value: [{ value: 'Unsaved original' }] }] }],
          },
        ],
      },
    };
    act(() => hook.result.current.reject(nativeValue, 'Merged cells unsupported'));
    await waitFor(() => expect(journal.writeRejectedDocumentEdit).toHaveBeenCalledTimes(1));
    const row = vi.mocked(journal.writeRejectedDocumentEdit).mock.calls[0]![0];
    expect(row).toMatchObject({
      userId: 'user-a',
      bookId: '1',
      scope: { kind: 'scene', id: '2' },
      baseRevisionId: source.revisionId,
      baseContentHash: source.contentHash,
      nativeValue,
      canonicalBase: source.document,
    });
    expect(hook.result.current.pending).toBe(true);
    await act(async () => {
      await hook.result.current.discard();
    });
    expect(journal.deleteRejectedDocumentEdit).toHaveBeenCalledWith(
      'user-a',
      '1',
      { kind: 'scene', id: '2' },
      row.id,
    );
    expect(hook.result.current.pending).toBe(false);
    expect(hook.result.current.discardToken).toBe(1);
  });
  it('suppresses late recovery from a previous authenticated account', async () => {
    let finish!: (row: journal.RejectedDocumentEdit) => void;
    vi.mocked(journal.readRejectedDocumentEdit).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const hook = renderHook(
      ({ user }) => useRejectedDocumentEdit(user, '1', 'scene', '2', source),
      { initialProps: { user: 'user-a' } },
    );
    hook.rerender({ user: 'user-b' });
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    await act(async () => {
      finish({
        schemaVersion: 1,
        id: 'private',
        userId: 'user-a',
        bookId: '1',
        scope: { kind: 'scene', id: '2' },
        updatedAt: Date.now(),
        baseRevisionId: 'scene-source',
        baseContentHash: 'a'.repeat(64),
        editorVersion: '1.0.4-proser.3',
        canonicalBase: source.document,
        nativeValue: { secret: 'old account' },
        error: 'private',
      });
      await Promise.resolve();
    });
    expect(hook.result.current.retained).toBeUndefined();
    expect(hook.result.current.pending).toBe(false);
  });
  it('keeps rejection visible when storage fails instead of claiming a saved draft', async () => {
    vi.mocked(journal.writeRejectedDocumentEdit).mockRejectedValue(
      new Error('Storage full; keep this page open'),
    );
    const hook = renderHook(() => useRejectedDocumentEdit('user-a', '1', 'scene', '2', source));
    await waitFor(() => expect(hook.result.current.ready).toBe(true));
    act(() =>
      hook.result.current.reject(
        { data: { main: [{ value: 'unacknowledged' }] } },
        'Unsupported edit',
      ),
    );
    await waitFor(() =>
      expect(hook.result.current.error).toBe('Storage full; keep this page open'),
    );
    expect(hook.result.current.pending).toBe(true);
    expect(hook.result.current.retained!.nativeValue).toEqual({
      data: { main: [{ value: 'unacknowledged' }] },
    });
  });
});
