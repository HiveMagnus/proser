import { webcrypto } from 'node:crypto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  documentFromText,
  type DocumentStorySourceRecord,
  type DocumentStoryDiscussionRecord,
  type DocumentStoryProposalRecord,
  type DocumentParagraph,
} from '@hivemagnus/proser-contracts';
import { storyDraftContext } from '@/lib/document-story-draft';
import { DocumentStoryDiscussion } from '@/components/editor/document-story-discussion';
import * as api from '@/lib/document-story-api';
vi.mock('@/lib/document-story-api', () => ({
  getDocumentStory: vi.fn(),
  prepareStoryDiscussion: vi.fn(),
  listStoryDiscussions: vi.fn(),
  requestStoryProposal: vi.fn(),
  getStoryProposal: vi.fn(),
  cancelStoryProposal: vi.fn(),
  revalidateStoryProposal: vi.fn(),
  applyStoryProposal: vi.fn(),
  getStoryDiscussion: vi.fn(),
  listStoryProposals: vi.fn(),
}));
const saved = (): DocumentStorySourceRecord => {
  let sequence = 0;
  const document = documentFromText('Owned header.', () => `header-${++sequence}`);
  return {
    sourceKind: 'layout-story',
    storyId: 'owned-header',
    bookId: 1,
    bookRevisionId: 'book-source',
    layoutRevisionId: 'layout-source',
    layoutContentHash: 'layout-hash',
    contentHash: 'doc-hash',
    ownerContextHash: 'owner-hash',
    document,
    styles: { text: {}, paragraph: {} },
  };
};
const discussion = (source: DocumentStorySourceRecord): DocumentStoryDiscussionRecord => ({
  id: 'context',
  bookId: 1,
  storyId: source.storyId,
  sessionId: 'session',
  createdAt: '2026-10-06',
  snapshot: {
    schemaVersion: 1,
    sourceKind: 'layout-story',
    storyId: source.storyId,
    sourceBookRevisionId: source.bookRevisionId,
    sourceLayoutRevisionId: source.layoutRevisionId,
    sourceLayoutContentHash: source.layoutContentHash,
    sourceBookContentHash: 'bookhash',
    ownerContextHash: source.ownerContextHash,
    sourceContentHash: source.contentHash,
    localDraftDigest: 'draft',
    unsaved: true,
    sessionId: 'session',
    projection: 'final',
    targets: [],
    blocks: source.document.blocks.filter((b) => b.type === 'paragraph'),
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
const proposal = (): DocumentStoryProposalRecord => ({
  id: 'proposal',
  discussionId: 'context',
  bookId: 1,
  storyId: 'owned-header',
  status: 'ready',
  request: { operationId: 'proposal', instruction: 'Improve.' },
  providerOutcome: 'completed',
  application: null,
  result: {
    raw: '',
    output: {
      reply: 'Owned story proposal.',
      edits: [
        { targetId: 'target', sourceText: 'Owned draft header.', replacement: 'Revised header.' },
      ],
    },
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('crypto', webcrypto);
  vi.mocked(api.listStoryDiscussions).mockResolvedValue([]);
  vi.mocked(api.listStoryProposals).mockResolvedValue([]);
});
describe('owned-story discussion workspace', () => {
  it('discloses bounded unsaved context without scene IDs and flushes identical operations before revalidation/apply', async () => {
    const source = saved(),
      current = structuredClone(source.document);
    (current.blocks[0] as DocumentParagraph).runs[0]!.text = 'Owned draft header.';
    vi.mocked(api.getDocumentStory).mockResolvedValue(source);
    vi.mocked(api.prepareStoryDiscussion).mockResolvedValue(discussion(source));
    vi.mocked(api.requestStoryProposal).mockResolvedValue(proposal());
    vi.mocked(api.getStoryProposal).mockResolvedValue({ ...proposal(), status: 'applied' });
    vi.mocked(api.revalidateStoryProposal).mockResolvedValue({
      id: 'validation',
      proposalId: 'proposal',
      bookId: 1,
      bookRevisionId: 'book-flushed',
      layoutRevisionId: 'layout-flushed',
      storyId: source.storyId,
      contentHash: 'flushed',
      targets: [],
    });
    const receipt = {
      kind: 'catalog',
      operationId: 'application',
      revisionId: 'book-applied',
      status: 'completed',
      manifest: {},
      result: { sourceKind: 'layout-story', storyId: source.storyId, proposalId: 'proposal' },
    } as Awaited<ReturnType<typeof api.applyStoryProposal>>;
    vi.mocked(api.applyStoryProposal).mockResolvedValue(receipt);
    const flush = vi.fn().mockResolvedValue({
      ...source,
      bookRevisionId: 'book-flushed',
      layoutRevisionId: 'layout-flushed',
      document: current,
    });
    const refresh = vi.fn().mockResolvedValue(undefined),
      user = userEvent.setup();
    render(
      <DocumentStoryDiscussion
        bookId="1"
        storyId={source.storyId}
        document={current}
        flush={flush}
        refresh={refresh}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Prepare context' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Prepare context' }));
    await screen.findByRole('region', { name: 'Inference context disclosure' });
    const context = vi.mocked(api.prepareStoryDiscussion).mock.calls[0]![1];
    expect(context).toMatchObject({
      storyId: source.storyId,
      expectedLayoutRevisionId: 'layout-source',
      targets: [{ sourceText: 'Owned draft header.' }],
    });
    expect(context).not.toHaveProperty('sceneId');
    expect(context).not.toHaveProperty('localDocument');
    expect(context.localOperations?.operations[0]?.kind).toBe('text');
    await user.type(screen.getByRole('textbox', { name: 'Discussion instruction' }), 'Improve.');
    await user.click(screen.getByRole('button', { name: 'Send disclosed context' }));
    await screen.findByText('Owned story proposal.');
    await user.click(
      screen.getByRole('button', { name: 'Save, revalidate and apply selected edits' }),
    );
    await waitFor(() => expect(api.applyStoryProposal).toHaveBeenCalledTimes(1));
    expect(flush).toHaveBeenCalledWith(context.localOperations);
    expect(api.revalidateStoryProposal).toHaveBeenCalledWith(
      '1',
      'proposal',
      expect.objectContaining({
        expectedRevisionId: 'book-flushed',
        expectedLayoutRevisionId: 'layout-flushed',
      }),
    );
    expect(api.applyStoryProposal).toHaveBeenCalledWith(
      '1',
      'proposal',
      expect.objectContaining({
        expectedRevisionId: 'book-flushed',
        expectedLayoutRevisionId: 'layout-flushed',
        targetIds: ['target'],
      }),
    );
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.revalidateStoryProposal).mock.invocationCallOrder[0]!,
    );
    expect(refresh).toHaveBeenCalledWith(receipt);
  });

  it('recovers an applied story by its retained exact receipt without repeating inference', async () => {
    const source = saved(),
      user = userEvent.setup();
    vi.mocked(api.getDocumentStory).mockResolvedValue(source);
    vi.mocked(api.prepareStoryDiscussion).mockResolvedValue(discussion(source));
    vi.mocked(api.requestStoryProposal).mockRejectedValue(new Error('Lost acknowledgement'));
    const application = {
      kind: 'catalog',
      operationId: 'original-application',
      revisionId: 'original-book',
      contentHash: 'bookhash',
      status: 'completed',
      manifest: {},
      result: {
        sourceKind: 'layout-story',
        storyId: source.storyId,
        proposalId: 'proposal',
        targetIds: ['target'],
      },
    } as NonNullable<DocumentStoryProposalRecord['application']>;
    vi.mocked(api.getStoryProposal).mockResolvedValue({
      ...proposal(),
      status: 'applied',
      application,
    });
    const refresh = vi.fn().mockResolvedValue(undefined);
    render(
      <DocumentStoryDiscussion
        bookId="1"
        storyId={source.storyId}
        document={source.document}
        flush={vi.fn()}
        refresh={refresh}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Prepare context' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Prepare context' }));
    await screen.findByRole('region', { name: 'Inference context disclosure' });
    await user.type(screen.getByRole('textbox', { name: 'Discussion instruction' }), 'Improve.');
    await user.click(screen.getByRole('button', { name: 'Send disclosed context' }));
    await screen.findByText('Lost acknowledgement');
    await user.click(screen.getByRole('button', { name: 'Recover saved response' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledWith(application));
    expect(api.requestStoryProposal).toHaveBeenCalledTimes(1);
  });

  it('restores original intention identities from owned discussion history after a restart', async () => {
    const source = saved(),
      current = structuredClone(source.document),
      user = userEvent.setup();
    (current.blocks[0] as DocumentParagraph).runs[0]!.text = 'Owned draft header.';
    const retained = await storyDraftContext(
      source,
      current,
      'original-draft-operation',
      (key) => 'original-' + key,
    );
    const record = { ...discussion(source), draftOperations: retained.localOperations };
    vi.mocked(api.getDocumentStory).mockResolvedValue(source);
    vi.mocked(api.listStoryDiscussions).mockResolvedValue([record]);
    vi.mocked(api.getStoryDiscussion).mockResolvedValue(record);
    vi.mocked(api.listStoryProposals).mockResolvedValue([
      { id: 'proposal', status: 'ready', createdAt: '2026-10-06' },
    ]);
    vi.mocked(api.getStoryProposal).mockResolvedValue(proposal());
    vi.mocked(api.revalidateStoryProposal).mockResolvedValue({
      id: 'validation',
      proposalId: 'proposal',
      bookId: 1,
      bookRevisionId: 'book-flushed',
      layoutRevisionId: 'layout-flushed',
      storyId: source.storyId,
      contentHash: 'flushed',
      targets: [],
    });
    vi.mocked(api.applyStoryProposal).mockResolvedValue(
      {} as Awaited<ReturnType<typeof api.applyStoryProposal>>,
    );
    const flush = vi.fn().mockResolvedValue({
      ...source,
      bookRevisionId: 'book-flushed',
      layoutRevisionId: 'layout-flushed',
      document: current,
    });
    render(
      <DocumentStoryDiscussion
        bookId="1"
        storyId={source.storyId}
        document={current}
        flush={flush}
        refresh={vi.fn()}
      />,
    );
    await screen.findByText('Saved discussions');
    await user.click(screen.getByText('Saved discussions'));
    await user.click(screen.getByRole('button', { name: /10\/6\/2026/ }));
    await user.click(await screen.findByRole('button', { name: 'Recover ready proposal' }));
    await screen.findByText('Owned story proposal.');
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Save, revalidate and apply selected edits' }),
      ).toBeEnabled(),
    );
    await user.click(
      screen.getByRole('button', { name: 'Save, revalidate and apply selected edits' }),
    );
    await waitFor(() => expect(flush).toHaveBeenCalledWith(retained.localOperations));
    expect(api.requestStoryProposal).not.toHaveBeenCalled();
    expect(api.getDocumentStory).toHaveBeenCalledWith(
      '1',
      source.storyId,
      undefined,
      'book-source',
    );
  });
  it('blocks forged source/container context and never invokes provider preparation', async () => {
    const source = saved(),
      current = structuredClone(source.document);
    current.blocks[0]!.id = 'forged';
    vi.mocked(api.getDocumentStory).mockResolvedValue(source);
    render(
      <DocumentStoryDiscussion
        bookId="1"
        storyId={source.storyId}
        document={current}
        flush={vi.fn()}
        refresh={vi.fn()}
      />,
    );
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Prepare context' })).toBeDisabled();
    expect(api.prepareStoryDiscussion).not.toHaveBeenCalled();
  });
});
