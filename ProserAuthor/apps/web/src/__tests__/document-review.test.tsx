import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentReview } from '@/components/editor/document-review';
import type { useDocumentSession } from '@/hooks/use-document-session';
import type {
  DocumentTraceReview,
  DocumentCompareRequest,
  DocumentCompareReceipt,
} from '@hivemagnus/proser-contracts';
import * as api from '@/lib/document-api';
import * as journal from '@/lib/document-review-journal';
vi.mock('next-auth/react', () => ({
  useSession: vi.fn(() => ({ data: { user: { id: 'owned-user' } } })),
}));
vi.mock('@/lib/document-api', async (original) => ({
  ...(await original<typeof import('@/lib/document-api')>()),
  getDocumentTraceReview: vi.fn(),
  revalidateDocumentCompare: vi.fn(),
  recordDocumentCompare: vi.fn(),
  recoverDocumentCompare: vi.fn(),
  cancelDocumentAnalysis: vi.fn(),
}));
vi.mock('@/lib/document-review-journal', () => ({
  readDocumentCompareIntent: vi.fn(),
  writeDocumentCompareIntent: vi.fn(),
  deleteDocumentCompareIntent: vi.fn(),
}));
import { useSession } from 'next-auth/react';
const review = (): DocumentTraceReview => ({
  traceId: 'saved-trace',
  sceneId: 2,
  status: 'completed',
  findings: [
    {
      id: 1,
      title: 'Saved finding',
      message: 'Exact paragraph target',
      severity: 'suggestion',
      suggestion: null,
      state: 'bound',
    },
  ],
  compareCards: [
    {
      id: 3,
      title: 'Saved choice',
      message: 'Review the alternatives',
      optionALabel: 'Keep',
      optionAText: 'A precise phrase.',
      optionBLabel: 'Revise',
      optionBText: 'A clearer phrase.',
      status: 'open',
      state: 'bound',
    },
  ],
});
const saved = { bookRevisionId: 'book-source', revisionId: 'scene-source' };
const editor = () =>
  ({
    flush: vi.fn().mockResolvedValue(saved),
    reloadAcknowledged: vi.fn().mockResolvedValue(undefined),
  }) as unknown as ReturnType<typeof useDocumentSession>;
const session = (id: string) => ({ data: { user: { id } } }) as ReturnType<typeof useSession>;
const receipt = (request: DocumentCompareRequest): DocumentCompareReceipt => ({
  kind: 'catalog',
  operationId: request.operationId,
  revisionId: 'committed',
  contentHash: 'a'.repeat(64),
  status: 'completed',
  manifest: { schemaVersion: 1, scenes: [] },
  sceneReferences: [],
  result: {
    traceId: request.traceId,
    compareCardId: request.compareCardId,
    actionId: 1,
    applied: request.applyChosen,
    sourceBookRevisionId: request.expectedRevisionId,
    sourceSceneRevisionId: request.expectedSceneRevisionId,
  },
});
describe('structured findings and compare recovery', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(useSession).mockReturnValue(session('owned-user'));
    vi.mocked(api.getDocumentTraceReview).mockResolvedValue(review());
    vi.mocked(journal.readDocumentCompareIntent).mockResolvedValue(undefined);
    vi.mocked(journal.writeDocumentCompareIntent).mockResolvedValue(undefined);
    vi.mocked(journal.deleteDocumentCompareIntent).mockResolvedValue(undefined);
    vi.mocked(api.revalidateDocumentCompare).mockResolvedValue({
      id: 'validated',
      targetId: 'target',
      bookId: 1,
      bookRevisionId: saved.bookRevisionId,
      sceneRevisionId: saved.revisionId,
      contentHash: 'hash',
      target: {} as never,
    });
    vi.mocked(api.recordDocumentCompare).mockImplementation(async (_book, _scene, request) => ({
      documentReceipt: receipt(request),
    }));
  });
  it('flushes and explicitly revalidates before journaling and tracked application', async () => {
    const user = userEvent.setup();
    const editing = editor();
    const order: string[] = [];
    vi.mocked(editing.flush).mockImplementation(async () => {
      order.push('flush');
      return saved as never;
    });
    vi.mocked(journal.writeDocumentCompareIntent).mockImplementation(async () => {
      order.push('journal');
    });
    vi.mocked(api.recordDocumentCompare).mockImplementation(async (_book, _scene, request) => {
      order.push('commit');
      return { documentReceipt: receipt(request) };
    });
    render(<DocumentReview bookId="1" sceneId="2" editor={editing} />);
    await screen.findByText('Saved finding');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Revalidate and apply B' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Revalidate and apply B' }));
    await waitFor(() => expect(editing.reloadAcknowledged).toHaveBeenCalledOnce());
    expect(order).toEqual(['flush', 'journal', 'commit']);
    expect(api.revalidateDocumentCompare).toHaveBeenCalledWith(
      '1',
      'saved-trace',
      3,
      expect.objectContaining({
        expectedRevisionId: 'book-source',
        expectedSceneRevisionId: 'scene-source',
      }),
    );
    expect(api.recordDocumentCompare).toHaveBeenCalledWith(
      '1',
      '2',
      expect.objectContaining({
        traceId: 'saved-trace',
        compareCardId: 3,
        chosen: 'b',
        applyChosen: true,
        validationId: 'validated',
      }),
    );
    expect(journal.deleteDocumentCompareIntent).toHaveBeenCalledOnce();
  });
  it('an acknowledgement for another operation retains the original journal and cannot update the editor', async () => {
    const user = userEvent.setup(),
      editing = editor();
    vi.mocked(api.recordDocumentCompare).mockImplementation(async (_book, _scene, request) => ({
      documentReceipt: { ...receipt(request), operationId: 'foreign-operation' },
    }));
    render(<DocumentReview bookId="1" sceneId="2" editor={editing} />);
    await screen.findByText('Saved choice');
    await user.click(screen.getByRole('button', { name: 'Revalidate and apply B' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('incompatible compare receipt');
    expect(journal.deleteDocumentCompareIntent).not.toHaveBeenCalled();
    expect(editing.reloadAcknowledged).not.toHaveBeenCalled();
  });
  it('journal failure blocks dispatch and leaves canonical content unchanged', async () => {
    const user = userEvent.setup();
    const editing = editor();
    vi.mocked(journal.writeDocumentCompareIntent).mockRejectedValue(
      new Error('Local journal unavailable'),
    );
    render(<DocumentReview bookId="1" sceneId="2" editor={editing} />);
    await screen.findByText('Saved choice');
    await user.click(screen.getByRole('button', { name: 'Revalidate and apply B' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Local journal unavailable');
    expect(api.recordDocumentCompare).not.toHaveBeenCalled();
    expect(editing.reloadAcknowledged).not.toHaveBeenCalled();
  });
  it('lost acknowledgement retains the exact operation; receipt recovery does not repeat the choice', async () => {
    const user = userEvent.setup();
    const editing = editor();
    const pendingChange = vi.fn();
    vi.mocked(api.recordDocumentCompare).mockRejectedValue(new Error('Response lost'));
    vi.mocked(api.recoverDocumentCompare).mockImplementation(async () =>
      receipt(vi.mocked(journal.writeDocumentCompareIntent).mock.calls[0]![0].request),
    );
    render(
      <DocumentReview bookId="1" sceneId="2" editor={editing} onPendingChange={pendingChange} />,
    );
    await screen.findByText('Saved choice');
    await user.click(screen.getByRole('button', { name: 'Revalidate and apply B' }));
    await screen.findByText('Response lost');
    expect(journal.deleteDocumentCompareIntent).not.toHaveBeenCalled();
    expect(pendingChange).toHaveBeenLastCalledWith(true);
    const intent = vi.mocked(journal.writeDocumentCompareIntent).mock.calls[0]![0];
    await user.click(screen.getByRole('button', { name: 'Recover choice' }));
    await waitFor(() => expect(editing.reloadAcknowledged).toHaveBeenCalledOnce());
    expect(api.recoverDocumentCompare).toHaveBeenCalledWith('1', intent.request.operationId);
    expect(api.recordDocumentCompare).toHaveBeenCalledOnce();
    expect(pendingChange).toHaveBeenLastCalledWith(false);
  });
  it('receipt absence enables only an explicit retry of the original guarded request', async () => {
    const user = userEvent.setup();
    const editing = editor();
    vi.mocked(api.recordDocumentCompare).mockRejectedValueOnce(new Error('Request interrupted'));
    vi.mocked(api.recoverDocumentCompare).mockRejectedValue(
      new api.DocumentRequestError('Not found', 404),
    );
    render(<DocumentReview bookId="1" sceneId="2" editor={editing} />);
    await screen.findByText('Saved choice');
    await user.click(screen.getByRole('button', { name: 'Revalidate and apply B' }));
    await screen.findByText('Request interrupted');
    const original = vi.mocked(api.recordDocumentCompare).mock.calls[0]![2];
    expect(screen.queryByRole('button', { name: 'Retry exact choice' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Recover choice' }));
    await user.click(await screen.findByRole('button', { name: 'Retry exact choice' }));
    await waitFor(() => expect(editing.reloadAcknowledged).toHaveBeenCalledOnce());
    expect(vi.mocked(api.recordDocumentCompare).mock.calls[1]![2]).toEqual(original);
    expect(api.revalidateDocumentCompare).toHaveBeenCalledOnce();
  });
  it('stale/unbound findings remain visible and cannot apply a compare proposal', async () => {
    const row = review();
    row.findings[0]!.state = 'stale';
    row.compareCards[0]!.state = 'unbound';
    vi.mocked(api.getDocumentTraceReview).mockResolvedValue(row);
    render(<DocumentReview bookId="1" sceneId="2" editor={editor()} />);
    await screen.findByText('Target changed · prepare a new proposal');
    expect(screen.getByRole('button', { name: 'Revalidate and apply B' })).toBeDisabled();
    expect(api.revalidateDocumentCompare).not.toHaveBeenCalled();
  });
  it('preference recording and tracked application remain separate actions', async () => {
    const user = userEvent.setup();
    const editing = editor();
    render(<DocumentReview bookId="1" sceneId="2" editor={editing} />);
    await screen.findByText('Saved choice');
    await user.click(screen.getByRole('button', { name: 'Record A preference' }));
    await waitFor(() => expect(api.recordDocumentCompare).toHaveBeenCalledOnce());
    expect(api.revalidateDocumentCompare).not.toHaveBeenCalled();
    expect(vi.mocked(api.recordDocumentCompare).mock.calls[0]![2]).toMatchObject({
      chosen: 'a',
      applyChosen: false,
    });
  });
  it('account changes hide prior findings and ignore their late response', async () => {
    let release!: (value: DocumentTraceReview) => void;
    vi.mocked(api.getDocumentTraceReview).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const view = render(<DocumentReview bookId="1" sceneId="2" editor={editor()} />);
    vi.mocked(useSession).mockReturnValue(session('another-user'));
    vi.mocked(api.getDocumentTraceReview).mockResolvedValue(null);
    view.rerender(<DocumentReview bookId="1" sceneId="2" editor={editor()} />);
    await screen.findByText('No saved analysis for this scene.');
    release(review());
    await waitFor(() => expect(screen.queryByText('Saved finding')).not.toBeInTheDocument());
    expect(journal.readDocumentCompareIntent).toHaveBeenLastCalledWith('another-user', '1', '2');
  });
});
