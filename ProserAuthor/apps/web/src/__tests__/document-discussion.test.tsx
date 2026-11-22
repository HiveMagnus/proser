import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalDocument, documentFromText } from '@cheftaco/proser-editor';
import { DocumentDiscussion } from '@/components/editor/document-discussion';
import { BoundedDocumentDiscussion } from '@/components/editor/bounded-document-discussion';
import type { useDocumentSession } from '@/hooks/use-document-session';
import type {
  DocumentDiscussionRecord,
  DocumentProposalRecord,
  DocumentPassage,
  DocumentPassageOperation,
  DocumentManifest,
} from '@cheftaco/proser-contracts';
import * as api from '@/lib/document-api';
vi.mock('@/lib/document-api', () => ({
  prepareDocumentDiscussion: vi.fn(),
  requestDocumentProposal: vi.fn(),
  getDocumentProposal: vi.fn(),
  cancelDocumentProposal: vi.fn(),
  revalidateDocumentProposal: vi.fn(),
  applyDocumentProposal: vi.fn(),
  listDocumentDiscussions: vi.fn(),
  listDocumentProposals: vi.fn(),
  getDocumentDiscussion: vi.fn(),
}));

let sequence = 0;
const document = () =>
  documentFromText('First paragraph.\n\nRepeated paragraph.', () => `discussion-${++sequence}`);
const record = (source: ReturnType<typeof document>): DocumentDiscussionRecord => ({
  id: 'context-id',
  bookId: 1,
  sceneId: 1,
  sessionId: 'session-id',
  createdAt: '2026-10-05T12:00:00Z',
  snapshot: {
    schemaVersion: 1,
    sceneId: 1,
    sessionId: 'session-id',
    projection: 'final',
    sourceBookRevisionId: 'book-source',
    sourceSceneRevisionId: 'scene-source',
    sourceContentHash: 'hash-source',
    bookLayoutHash: 'layout-hash',
    localDraftDigest: 'draft-hash',
    unsaved: true,
    blocks: source.blocks.filter((block) => block.type === 'paragraph'),
    targets: [],
    codex: [],
    omitted: { blockIds: [], codexIds: [] },
    maxPromptBytes: 10000,
    maxOutputTokens: 2048,
    templateVersion: '1.0.0',
    conversation: [],
    omittedProposalIds: [],
    omittedEarlierTurnCount: 0,
  },
});
const proposal = (): DocumentProposalRecord => ({
  id: 'proposal-id',
  discussionId: 'context-id',
  bookId: 1,
  sceneId: 1,
  status: 'ready',
  request: { operationId: 'proposal-id', instruction: 'Edit this passage.' },
  providerOutcome: 'completed',
  application: null,
  result: {
    raw: '',
    output: {
      reply: 'A precise proposal.',
      edits: [
        {
          targetId: 'target-id',
          sourceText: 'Repeated paragraph.',
          replacement: 'Revised paragraph.',
        },
      ],
    },
  },
});
const editor = (): ReturnType<typeof useDocumentSession> => {
  const source = document();
  const saved = {
    sceneId: 1,
    revisionId: 'scene-source',
    bookRevisionId: 'book-source',
    contentHash: 'hash-source',
    document: source,
    projection: { text: 'First paragraph.\n\nRepeated paragraph.', wordCount: 4, spans: [] },
  };
  return {
    group: {
      peekDocument: vi.fn(),
      pendingSave: undefined,
      prepare: vi.fn(),
      stage: vi.fn(),
      acknowledge: vi.fn(),
      refreshBookRevision: vi.fn(),
      reject: vi.fn(),
    },
    canUndo: false,
    canRedo: false,
    undo: vi.fn(),
    redo: vi.fn(),
    document: source,
    saved,
    state: 'unsaved',
    error: undefined,
    recovery: undefined,
    conflictVersion: undefined,
    reconciliation: undefined,
    change: vi.fn(),
    save: vi.fn(),
    flush: vi.fn().mockResolvedValue(saved),
    reloadAcknowledged: vi.fn(),
    restoreDraft: vi.fn(),
    discardDraft: vi.fn(),
    inspectConflict: vi.fn(),
    useLocalDraft: vi.fn(),
    useSavedVersion: vi.fn(),
    useMergedDraft: vi.fn(),
    setError: vi.fn(),
  };
};
beforeEach(() => {
  sequence = 0;
  vi.resetAllMocks();
  vi.mocked(api.listDocumentDiscussions).mockResolvedValue([]);
  vi.mocked(api.listDocumentProposals).mockResolvedValue([]);
  vi.mocked(api.requestDocumentProposal).mockResolvedValue(proposal());
  vi.mocked(api.getDocumentProposal).mockResolvedValue(proposal());
  vi.mocked(api.revalidateDocumentProposal).mockResolvedValue({
    id: 'validation-id',
    proposalId: 'proposal-id',
    bookId: 1,
    bookRevisionId: 'book-current',
    sceneRevisionId: 'scene-current',
    contentHash: 'hash-current',
    targets: [],
  });
  vi.mocked(api.applyDocumentProposal).mockResolvedValue({
    kind: 'catalog',
    operationId: 'apply-id',
    revisionId: 'book-applied',
    status: 'completed',
    sceneReferences: [],
    contentHash: 'book-hash',
    manifest: {} as DocumentManifest,
    result: {
      proposalId: 'proposal-id',
      targetIds: ['target-id'],
      sceneId: 1,
      sourceBookRevisionId: 'book-current',
      sourceSceneRevisionId: 'scene-current',
    },
  });
});
describe('document discussion controls', () => {
  it('sends frozen selected spans and invalidates disclosure when the selection changes', async () => {
    const user = userEvent.setup();
    const session = editor();
    const blockId = session.document!.blocks[1]!.id;
    const selection = {
      projection: 'final' as const,
      targets: [{ blockId, from: 0, to: 8, sourceText: 'Repeated' }],
      runs: [],
      container: {},
    };
    vi.mocked(api.prepareDocumentDiscussion).mockResolvedValue(record(session.document!));
    const { rerender } = render(
      <DocumentDiscussion bookId="1" sceneId="1" editor={session} selection={selection} />,
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Discussion target' }),
      'selection',
    );
    await user.click(screen.getByRole('button', { name: 'Prepare context' }));
    await screen.findByRole('region', { name: 'Inference context disclosure' });
    expect(api.prepareDocumentDiscussion).toHaveBeenCalledWith(
      '1',
      expect.objectContaining({ targets: selection.targets }),
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Discussion instruction' }),
      'Edit selected words.',
    );
    expect(screen.getByRole('button', { name: 'Send disclosed context' })).toBeEnabled();
    rerender(
      <DocumentDiscussion
        bookId="1"
        sceneId="1"
        editor={session}
        selection={{
          ...selection,
          targets: [{ blockId, from: 9, to: 18, sourceText: 'paragraph' }],
        }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Send disclosed context' })).toBeDisabled();
    expect(api.requestDocumentProposal).not.toHaveBeenCalled();
  });
  it('discloses context before inference and flushes/revalidates before applying selected tracked edits', async () => {
    const user = userEvent.setup();
    const session = editor();
    vi.mocked(api.prepareDocumentDiscussion).mockResolvedValue(record(session.document!));
    render(<DocumentDiscussion bookId="1" sceneId="1" editor={session} />);
    expect(api.requestDocumentProposal).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Prepare context' }));
    expect(
      await screen.findByRole('region', { name: 'Inference context disclosure' }),
    ).toHaveTextContent('unsaved draft');
    expect(api.requestDocumentProposal).not.toHaveBeenCalled();
    await user.type(
      screen.getByRole('textbox', { name: 'Discussion instruction' }),
      'Edit this passage.',
    );
    await user.click(screen.getByRole('button', { name: 'Send disclosed context' }));
    await screen.findByText('A precise proposal.');
    expect(session.flush).not.toHaveBeenCalled();
    expect(api.applyDocumentProposal).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole('button', { name: 'Save, revalidate and apply selected edits' }),
    );
    await waitFor(() => expect(api.applyDocumentProposal).toHaveBeenCalledTimes(1));
    expect(session.flush).toHaveBeenCalledTimes(1);
    expect(api.revalidateDocumentProposal).toHaveBeenCalledWith(
      '1',
      'proposal-id',
      expect.objectContaining({
        expectedRevisionId: 'book-source',
        expectedSceneRevisionId: 'scene-source',
      }),
    );
    expect(api.applyDocumentProposal).toHaveBeenCalledWith(
      '1',
      'proposal-id',
      expect.objectContaining({
        validationId: 'validation-id',
        expectedRevisionId: 'book-current',
        expectedSceneRevisionId: 'scene-current',
        targetIds: ['target-id'],
      }),
    );
    expect(session.reloadAcknowledged).toHaveBeenCalledTimes(1);
  });
  it('invalidates disclosure after target or draft changes instead of silently sending another context', async () => {
    const user = userEvent.setup();
    const session = editor();
    vi.mocked(api.prepareDocumentDiscussion).mockResolvedValue(record(session.document!));
    const { rerender } = render(<DocumentDiscussion bookId="1" sceneId="1" editor={session} />);
    await user.click(screen.getByRole('button', { name: 'Prepare context' }));
    await user.type(
      await screen.findByRole('textbox', { name: 'Discussion instruction' }),
      'Edit.',
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Discussion target' }),
      session.document!.blocks[1]!.id,
    );
    expect(screen.getByRole('button', { name: 'Send disclosed context' })).toBeDisabled();
    const changed = structuredClone(session.document!);
    const first = changed.blocks[0];
    if (first?.type !== 'paragraph') throw new Error('fixture');
    first.runs[0]!.text = 'A new draft.';
    rerender(
      <DocumentDiscussion bookId="1" sceneId="1" editor={{ ...session, document: changed }} />,
    );
    expect(canonicalDocument(changed)).not.toBe(canonicalDocument(session.document));
    expect(screen.getByRole('button', { name: 'Send disclosed context' })).toBeDisabled();
    expect(api.requestDocumentProposal).not.toHaveBeenCalled();
  });
  it('recovers a lost acknowledgement by the retained ID without another provider request', async () => {
    const user = userEvent.setup();
    const session = editor();
    vi.mocked(api.prepareDocumentDiscussion).mockResolvedValue(record(session.document!));
    vi.mocked(api.requestDocumentProposal).mockRejectedValue(new Error('Acknowledgement lost'));
    render(<DocumentDiscussion bookId="1" sceneId="1" editor={session} />);
    await user.click(screen.getByRole('button', { name: 'Prepare context' }));
    await user.type(
      await screen.findByRole('textbox', { name: 'Discussion instruction' }),
      'Edit.',
    );
    await user.click(screen.getByRole('button', { name: 'Send disclosed context' }));
    await screen.findByRole('alert');
    const operationId = vi.mocked(api.requestDocumentProposal).mock.calls[0]![2].operationId;
    await user.click(screen.getByRole('button', { name: 'Recover saved response' }));
    await screen.findByText('A precise proposal.');
    expect(api.getDocumentProposal).toHaveBeenCalledWith('1', operationId);
    expect(api.requestDocumentProposal).toHaveBeenCalledTimes(1);
  });

  it('recovers the original applied receipt after a lost application acknowledgement before another mutation', async () => {
    const user = userEvent.setup(),
      session = editor();
    vi.mocked(api.prepareDocumentDiscussion).mockResolvedValue(record(session.document!));
    vi.mocked(api.applyDocumentProposal).mockRejectedValueOnce(
      new Error('Lost application acknowledgement'),
    );
    vi.mocked(api.getDocumentProposal).mockImplementation(async () => {
      const input = vi.mocked(api.applyDocumentProposal).mock.calls[0]![2];
      return {
        ...proposal(),
        status: 'applied',
        application: {
          kind: 'catalog',
          operationId: input.operationId,
          revisionId: 'original-book-applied',
          contentHash: 'book-hash',
          manifest: {} as DocumentManifest,
          sceneReferences: [],
          status: 'completed',
          result: {
            proposalId: 'proposal-id',
            targetIds: ['target-id'],
            sceneId: 1,
            sourceBookRevisionId: 'book-current',
            sourceSceneRevisionId: 'scene-current',
          },
        },
      };
    });
    render(<DocumentDiscussion bookId="1" sceneId="1" editor={session} />);
    await user.click(screen.getByRole('button', { name: 'Prepare context' }));
    await user.type(
      await screen.findByRole('textbox', { name: 'Discussion instruction' }),
      'Edit.',
    );
    await user.click(screen.getByRole('button', { name: 'Send disclosed context' }));
    await screen.findByText('A precise proposal.');
    await user.click(
      screen.getByRole('button', { name: 'Save, revalidate and apply selected edits' }),
    );
    await screen.findByText('Lost application acknowledgement');
    await user.click(
      screen.getByRole('button', { name: 'Save, revalidate and apply selected edits' }),
    );
    await screen.findByText(/Proposal applied as tracked changes/);
    expect(api.applyDocumentProposal).toHaveBeenCalledTimes(1);
    expect(api.revalidateDocumentProposal).toHaveBeenCalledTimes(1);
    expect(session.flush).toHaveBeenCalledTimes(1);
    expect(session.reloadAcknowledged).toHaveBeenCalledTimes(1);
    expect(api.requestDocumentProposal).toHaveBeenCalledTimes(1);
  });
  it('prepares bounded unsaved intents and applies only after flushed revision revalidation without a full scene document', async () => {
    const user = userEvent.setup();
    const source = document();
    const block = source.blocks[1];
    if (!block || block.type !== 'paragraph') throw new Error('fixture');
    const passage = {
      schemaVersion: 1,
      projection: 'final',
      sceneId: 1,
      bookRevisionId: 'book-source',
      sceneRevisionId: 'scene-source',
      contentHash: 'hash-source',
      windowHash: 'window-source',
      sourceFrame: { bookId: 1, sceneId: 1 },
      paragraphs: [{ paragraph: block, offset: 120, length: 19 }],
      images: [],
      changes: [],
      layout: source.layout,
    } as unknown as DocumentPassage;
    const localOperations = {
      operationId: crypto.randomUUID(),
      operations: [
        {
          id: 'edit',
          kind: 'text',
          target: {
            blockId: block.id,
            runId: block.runs[0]!.id,
            from: 120,
            to: 139,
            sourceHash: 'hash',
            paragraphHash: 'paragraph',
            containerHash: 'container',
          },
          expectedText: 'Repeated paragraph.',
          replacement: 'Local draft.',
        },
      ] as DocumentPassageOperation[],
    };
    const targets = [{ blockId: block.id, from: 120, to: 132, sourceText: 'Local draft.' }];
    const flush = vi.fn().mockResolvedValue({
      ...passage,
      bookRevisionId: 'flushed-book',
      sceneRevisionId: 'flushed-scene',
    });
    const refresh = vi.fn();
    const retainLocalOperations = vi.fn().mockResolvedValue(undefined);
    vi.mocked(api.prepareDocumentDiscussion).mockResolvedValue(record(source));
    render(
      <BoundedDocumentDiscussion
        passage={passage}
        targets={targets}
        localOperations={localOperations}
        retainLocalOperations={retainLocalOperations}
        sessionId="bounded-session"
        flush={flush}
        refresh={refresh}
      />,
    );
    expect(screen.getByRole('option', { name: 'Loaded passage' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Prepare context' }));
    await screen.findByRole('region', { name: 'Inference context disclosure' });
    const payload = vi.mocked(api.prepareDocumentDiscussion).mock.calls[0]![1];
    expect(payload).toMatchObject({
      sessionId: 'bounded-session',
      expectedRevisionId: 'book-source',
      expectedSceneRevisionId: 'scene-source',
      localOperations,
      targets,
    });
    expect(retainLocalOperations).toHaveBeenCalledWith(localOperations);
    expect(retainLocalOperations.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.prepareDocumentDiscussion).mock.invocationCallOrder[0]!,
    );
    expect(Object.hasOwn(payload, 'localDocument')).toBe(false);
    expect(api.requestDocumentProposal).not.toHaveBeenCalled();
    await user.type(
      screen.getByRole('textbox', { name: 'Discussion instruction' }),
      'Review the disclosed passage.',
    );
    await user.click(screen.getByRole('button', { name: 'Send disclosed context' }));
    await screen.findByText('A precise proposal.');
    await user.click(
      screen.getByRole('button', { name: 'Save, revalidate and apply selected edits' }),
    );
    await waitFor(() => expect(api.applyDocumentProposal).toHaveBeenCalledTimes(1));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(api.revalidateDocumentProposal).toHaveBeenCalledWith(
      '1',
      'proposal-id',
      expect.objectContaining({
        expectedRevisionId: 'flushed-book',
        expectedSceneRevisionId: 'flushed-scene',
      }),
    );
    expect(refresh).toHaveBeenCalledWith(
      await vi.mocked(api.applyDocumentProposal).mock.results[0]!.value,
      'flushed-scene',
    );
  });
  it('blocks guessed draft coordinates and invalidates disclosed intent changes even if a caller keeps its draft key', async () => {
    const user = userEvent.setup();
    const source = document();
    const block = source.blocks[0];
    if (!block || block.type !== 'paragraph') throw new Error('fixture');
    const passage = {
      projection: 'final',
      sceneId: 1,
      bookRevisionId: 'book-source',
      sceneRevisionId: 'scene-source',
      contentHash: 'hash-source',
      windowHash: 'window-source',
      sourceFrame: { bookId: 1, sceneId: 1 },
      paragraphs: [{ paragraph: block, offset: 0, length: 16 }],
    } as unknown as DocumentPassage;
    const operations = {
      operationId: crypto.randomUUID(),
      operations: [] as DocumentPassageOperation[],
    };
    const props = {
      passage,
      localOperations: operations,
      sessionId: 'bounded-session',
      draftKey: 'fixed',
      retainLocalOperations: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn(),
      refresh: vi.fn(),
    };
    vi.mocked(api.prepareDocumentDiscussion).mockResolvedValue(record(source));
    const { rerender } = render(<BoundedDocumentDiscussion {...props} />);
    expect(screen.getByRole('button', { name: 'Prepare context' })).toBeDisabled();
    const targets = [{ blockId: block.id, from: 0, to: 16, sourceText: 'First paragraph.' }];
    rerender(<BoundedDocumentDiscussion {...props} targets={targets} />);
    await user.click(screen.getByRole('button', { name: 'Prepare context' }));
    await user.type(
      await screen.findByRole('textbox', { name: 'Discussion instruction' }),
      'Discuss.',
    );
    expect(screen.getByRole('button', { name: 'Send disclosed context' })).toBeEnabled();
    rerender(
      <BoundedDocumentDiscussion
        {...props}
        targets={targets}
        localOperations={{ ...operations, operationId: crypto.randomUUID() }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Send disclosed context' })).toBeDisabled();
    expect(api.requestDocumentProposal).not.toHaveBeenCalled();
  });
});
