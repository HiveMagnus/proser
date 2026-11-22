'use client';
import { useEffect, useRef, useState } from 'react';
import {
  canonicalDocument,
  paragraphsOf,
  visibleParagraph,
  visibleRun,
  type DocumentSelection,
} from '@cheftaco/proser-editor';
import type {
  DocumentDiscussionRecord,
  DocumentProposalRecord,
  DocumentProposalRequest,
  DocumentProposalApplicationReceipt,
  DocumentProposalApply,
  DocumentStoryProposalApply,
  DocumentPassage,
  DocumentPassageOperation,
  DocumentTargetInput,
  DocumentStorySourceRecord,
  DocumentStoryDiscussionRecord,
  DocumentStoryProposalRecord,
  ProserDocument,
} from '@cheftaco/proser-contracts';
import type { useDocumentSession } from '@/hooks/use-document-session';
import {
  prepareDocumentDiscussion,
  requestDocumentProposal,
  getDocumentProposal,
  cancelDocumentProposal,
  revalidateDocumentProposal,
  applyDocumentProposal,
  listDocumentDiscussions,
  listDocumentProposals,
  getDocumentDiscussion,
} from '@/lib/document-api';
import { Button } from '@/components/ui/button';
import * as storyApi from '@/lib/document-story-api';

type Editor = ReturnType<typeof useDocumentSession>;
type DiscussionRecord = DocumentDiscussionRecord | DocumentStoryDiscussionRecord;
type ProposalRecord = DocumentProposalRecord | DocumentStoryProposalRecord;
export interface StoryDiscussionContext {
  source: DocumentStorySourceRecord;
  document: ProserDocument;
  targets: DocumentTargetInput[];
  localOperations?: { operationId: string; operations: DocumentPassageOperation[] };
  sessionId: string;
  draftKey: string;
  flush(): Promise<DocumentStorySourceRecord>;
  refresh(receipt?: unknown): Promise<void>;
  recoverContext?(record: DocumentStoryDiscussionRecord): Promise<void>;
  blocked?: boolean;
}
export interface BoundedDiscussionContext {
  passage: DocumentPassage;
  targets: DocumentTargetInput[];
  localOperations?: { operationId: string; operations: DocumentPassageOperation[] };
  sessionId: string;
  draftKey: string;
  flush(): Promise<DocumentPassage>;
  refresh(
    receipt: DocumentProposalApplicationReceipt,
    beforeSceneRevisionId?: string,
  ): Promise<void>;
  retainLocalOperations?(local: {
    operationId: string;
    operations: DocumentPassageOperation[];
  }): Promise<void>;
  blocked?: boolean;
}
/** Discussion, proposal application and tracked-change resolution are distinct
 * actions. This component never saves a returned plain prose string. */
export function DocumentDiscussion({
  bookId,
  sceneId,
  editor,
  bounded,
  story,
  selection,
  selectionError,
  disabled,
}: {
  bookId: string;
  sceneId?: string;
  editor?: Editor;
  bounded?: BoundedDiscussionContext;
  story?: StoryDiscussionContext;
  selection?: DocumentSelection;
  selectionError?: string;
  disabled?: boolean;
}) {
  const [sessionId] = useState(() => story?.sessionId ?? bounded?.sessionId ?? crypto.randomUUID());
  const [target, setTarget] = useState('scene');
  const [instruction, setInstruction] = useState('');
  const [prepared, setPrepared] = useState<{
    record: DiscussionRecord;
    draft: string;
    target: string;
  }>();
  const [proposal, setProposal] = useState<ProposalRecord>();
  const [busy, setBusy] = useState<'prepare' | 'infer' | 'apply' | 'recover'>();
  const [error, setError] = useState<string>();
  const [history, setHistory] = useState<DiscussionRecord[]>([]);
  const [choices, setChoices] = useState<Array<{ id: string; status: string; createdAt: string }>>(
    [],
  );
  const [selectedEdits, setSelectedEdits] = useState<string[]>([]);
  const attempt = useRef<{ discussionId: string; input: DocumentProposalRequest } | undefined>(
    undefined,
  );
  const application = useRef<
    | {
        proposalId: string;
        operationId: string;
        input?: DocumentProposalApply | DocumentStoryProposalApply;
      }
    | undefined
  >(undefined);
  const controller = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const paragraphs = story
    ? paragraphsOf(story.document).filter((block) =>
        visibleParagraph(block, story.document.changes, 'final'),
      )
    : bounded
      ? bounded.passage.paragraphs.map((item) => item.paragraph)
      : editor?.document
        ? paragraphsOf(editor.document).filter((block) =>
            visibleParagraph(block, editor.document!.changes, 'final'),
          )
        : [];
  const currentDraft =
    story?.draftKey ??
    bounded?.draftKey ??
    (editor?.document ? canonicalDocument(editor.document) : '');
  const reload = async (receipt?: unknown, beforeSceneRevisionId?: string) =>
    story
      ? story.refresh(receipt)
      : bounded
        ? bounded.refresh(receipt as DocumentProposalApplicationReceipt, beforeSceneRevisionId)
        : editor!.reloadAcknowledged();
  const storyId = story?.source.storyId;
  const targetKey =
    target === 'selection' ? `selection:${canonicalDocument(selection?.targets ?? [])}` : target;
  const staleDisclosure = prepared?.draft !== currentDraft || prepared?.target !== targetKey;
  useEffect(() => {
    mounted.current = true;
    void (
      storyId
        ? storyApi.listStoryDiscussions(bookId, storyId)
        : listDocumentDiscussions(bookId, sceneId!)
    )
      .then((rows) => {
        if (mounted.current) setHistory(rows);
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, [bookId, sceneId, storyId]);
  const report = (failure: unknown) => {
    if (mounted.current)
      setError(
        failure instanceof Error ? failure.message : 'Unable to complete this document action.',
      );
  };
  const acceptRecord = (row: ProposalRecord) => {
    if (!mounted.current) return;
    setProposal(row);
    setSelectedEdits(row.result?.output?.edits.map((edit) => edit.targetId) ?? []);
  };
  const prepare = async () => {
    if (
      disabled ||
      busy ||
      story?.blocked ||
      bounded?.blocked ||
      (!story && !bounded && (!editor?.saved || !editor.document))
    )
      return;
    setBusy('prepare');
    setError(undefined);
    try {
      const document = editor?.document ? structuredClone(editor.document) : undefined;
      const selected = paragraphs.filter((block) => target === 'scene' || block.id === target);
      if (target === 'selection' ? !selection?.targets.length : !selected.length)
        throw new Error('Select current manuscript text before preparing context.');
      const targets =
        target === 'selection'
          ? structuredClone(selection!.targets)
          : story
            ? story.targets.filter((item) => target === 'scene' || item.blockId === target)
            : bounded
              ? bounded.targets.filter((item) => target === 'scene' || item.blockId === target)
              : selected.map((block) => {
                  const text = block.runs
                    .filter((run) => visibleRun(run, document!.changes, 'final'))
                    .map((run) => run.text)
                    .join('');
                  return { blockId: block.id, from: 0, to: text.length, sourceText: text };
                });
      const common = {
        schemaVersion: 1 as const,
        ...(prepared ? { parentDiscussionId: prepared.record.id } : {}),
        operationId: crypto.randomUUID(),
        sessionId,
        projection: 'final' as const,
        targets,
      };
      if (bounded?.localOperations) {
        if (!bounded.retainLocalOperations)
          throw new Error(
            'This session cannot retain the original draft intentions. Save before preparing context.',
          );
        await bounded.retainLocalOperations(structuredClone(bounded.localOperations));
      }
      const record = story
        ? await storyApi.prepareStoryDiscussion(bookId, {
            ...common,
            storyId: story.source.storyId,
            expectedRevisionId: story.source.bookRevisionId,
            expectedLayoutRevisionId: story.source.layoutRevisionId,
            expectedContentHash: story.source.contentHash,
            ...(story.localOperations
              ? { localOperations: structuredClone(story.localOperations) }
              : {}),
          })
        : await prepareDocumentDiscussion(bookId, {
            ...common,
            sceneId: Number(sceneId),
            expectedRevisionId: bounded?.passage.bookRevisionId ?? editor!.saved!.bookRevisionId,
            expectedSceneRevisionId: bounded?.passage.sceneRevisionId ?? editor!.saved!.revisionId,
            expectedContentHash: bounded?.passage.contentHash ?? editor!.saved!.contentHash,
            ...(bounded
              ? bounded.localOperations
                ? { localOperations: structuredClone(bounded.localOperations) }
                : {}
              : { localDocument: document }),
          });
      if (mounted.current) {
        setPrepared({ record, draft: currentDraft, target: targetKey });
        setProposal(undefined);
        attempt.current = undefined;
        setHistory((rows) => [record, ...rows.filter((row) => row.id !== record.id)].slice(0, 10));
      }
    } catch (failure) {
      report(failure);
    } finally {
      if (mounted.current) setBusy(undefined);
    }
  };
  const send = async () => {
    if (disabled) return;
    if (!prepared || staleDisclosure || busy || !instruction.trim()) return;
    setBusy('infer');
    setError(undefined);
    const input =
      attempt.current?.discussionId === prepared.record.id
        ? attempt.current.input
        : { operationId: crypto.randomUUID(), instruction };
    if (input.instruction !== instruction) {
      setError('Recover the previous request before sending a changed instruction.');
      setBusy(undefined);
      return;
    }
    attempt.current = { discussionId: prepared.record.id, input };
    controller.current = new AbortController();
    try {
      acceptRecord(
        await (story ? storyApi.requestStoryProposal : requestDocumentProposal)(
          bookId,
          prepared.record.id,
          input,
          controller.current.signal,
        ),
      );
    } catch (failure) {
      report(failure);
    } finally {
      if (mounted.current) setBusy(undefined);
    }
  };
  const recover = async (id = attempt.current?.input.operationId ?? proposal?.id) => {
    if (!id) return;
    setBusy('recover');
    setError(undefined);
    try {
      const row = await (story ? storyApi.getStoryProposal : getDocumentProposal)(bookId, id);
      acceptRecord(row);
      if (
        row.status === 'applied' &&
        row.application &&
        (!application.current || application.current.operationId === row.application.operationId)
      )
        await reload(
          row.application,
          !story && 'result' in row.application
            ? (row.application as DocumentProposalApplicationReceipt).result.sourceSceneRevisionId
            : undefined,
        );
    } catch (failure) {
      report(failure);
    } finally {
      if (mounted.current) setBusy(undefined);
    }
  };
  const cancel = async () => {
    const id = attempt.current?.input.operationId ?? proposal?.id;
    if (!id) return;
    setError(undefined);
    try {
      await (story ? storyApi.cancelStoryProposal : cancelDocumentProposal)(bookId, id);
      controller.current?.abort();
      await recover(id);
    } catch (failure) {
      report(failure);
    }
  };
  const apply = async () => {
    if (disabled) return;
    if (!proposal || proposal.status !== 'ready' || !selectedEdits.length || busy) return;
    setBusy('apply');
    setError(undefined);
    try {
      const previous =
        application.current?.proposalId === proposal.id ? application.current : undefined;
      const operationId = previous?.operationId ?? crypto.randomUUID();
      application.current = previous ?? { proposalId: proposal.id, operationId };
      if (previous?.input) {
        const current = await (story ? storyApi.getStoryProposal : getDocumentProposal)(
          bookId,
          proposal.id,
        );
        if (current.status === 'applied' && current.application) {
          if (current.application.operationId !== operationId)
            throw new Error('Recover the recorded original application before continuing.');
          await reload(
            current.application,
            !story
              ? (current.application as DocumentProposalApplicationReceipt).result
                  .sourceSceneRevisionId
              : undefined,
          );
          acceptRecord(current);
          return;
        }
        if (current.status !== 'ready')
          throw new Error('The original application needs recovery before retrying.');
        const receipt = story
          ? await storyApi.applyStoryProposal(
              bookId,
              proposal.id,
              previous.input as DocumentStoryProposalApply,
            )
          : await applyDocumentProposal(
              bookId,
              proposal.id,
              previous.input as DocumentProposalApply,
            );
        await reload(
          receipt,
          !story ? (previous.input as DocumentProposalApply).expectedSceneRevisionId : undefined,
        );
        acceptRecord(
          await (story ? storyApi.getStoryProposal : getDocumentProposal)(bookId, proposal.id),
        );
        return;
      }
      if (story) {
        const saved = await story.flush();
        const validation = await storyApi.revalidateStoryProposal(bookId, proposal.id, {
          operationId: crypto.randomUUID(),
          expectedRevisionId: saved.bookRevisionId,
          expectedLayoutRevisionId: saved.layoutRevisionId,
        });
        const input: DocumentStoryProposalApply = {
          operationId,
          expectedRevisionId: validation.bookRevisionId,
          expectedLayoutRevisionId: validation.layoutRevisionId,
          validationId: validation.id,
          targetIds: selectedEdits,
        };
        application.current.input = input;
        const receipt = await storyApi.applyStoryProposal(bookId, proposal.id, input);
        await reload(receipt);
        acceptRecord(await storyApi.getStoryProposal(bookId, proposal.id));
      } else {
        const saved = bounded
          ? await bounded.flush().then((passage) => ({
              bookRevisionId: passage.bookRevisionId,
              revisionId: passage.sceneRevisionId,
            }))
          : await editor!.flush();
        const validation = await revalidateDocumentProposal(bookId, proposal.id, {
          operationId: crypto.randomUUID(),
          expectedRevisionId: saved.bookRevisionId,
          expectedSceneRevisionId: saved.revisionId,
        });
        const input: DocumentProposalApply = {
          operationId,
          expectedRevisionId: validation.bookRevisionId,
          expectedSceneRevisionId: validation.sceneRevisionId,
          validationId: validation.id,
          targetIds: selectedEdits,
        };
        application.current.input = input;
        const receipt = await applyDocumentProposal(bookId, proposal.id, input);
        await reload(receipt, saved.revisionId);
        acceptRecord(await getDocumentProposal(bookId, proposal.id));
      }
    } catch (failure) {
      report(failure);
    } finally {
      if (mounted.current) setBusy(undefined);
    }
  };
  const openHistory = async (id: string) => {
    setBusy('recover');
    setError(undefined);
    try {
      const record = await (story ? storyApi.getStoryDiscussion : getDocumentDiscussion)(
        bookId,
        id,
      );
      if (story?.recoverContext)
        await story.recoverContext(record as DocumentStoryDiscussionRecord);
      const rows = await (story ? storyApi.listStoryProposals : listDocumentProposals)(bookId, id);
      if (mounted.current) {
        setPrepared({ record, draft: '', target: '' });
        setChoices(rows);
        setProposal(undefined);
        attempt.current = undefined;
      }
    } catch (failure) {
      report(failure);
    } finally {
      if (mounted.current) setBusy(undefined);
    }
  };
  const output = proposal?.result?.output;
  return (
    <aside
      aria-label="Document discussion"
      className="space-y-4 rounded-[--radius-lg] border border-border-muted bg-surface-raised/60 p-4"
    >
      <h2 className="text-lg font-semibold">Discuss this manuscript</h2>
      <label className="block space-y-1 text-sm">
        Target
        <select
          aria-label="Discussion target"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          disabled={!!busy}
          className="block min-h-11 w-full rounded border border-border-muted bg-surface-base px-2"
        >
          <option value="scene">
            {story ? 'Whole story' : bounded ? 'Loaded passage' : 'Whole scene'}
          </option>
          <option value="selection" disabled={!selection?.targets.length}>
            Selected text
          </option>
          {paragraphs.map((block, index) => (
            <option key={block.id} value={block.id}>
              Paragraph {index + 1}
            </option>
          ))}
        </select>
      </label>
      {selectionError && <p role="status">{selectionError}</p>}
      <Button
        type="button"
        onClick={() => void prepare()}
        disabled={
          disabled ||
          !!busy ||
          (story
            ? story.blocked || !story.targets.length
            : bounded
              ? bounded.blocked || !bounded.targets.length
              : !editor?.document || !!editor.recovery || editor.state === 'conflict')
        }
        className="min-h-11"
      >
        Prepare context
      </Button>
      {prepared && (
        <section
          aria-label="Inference context disclosure"
          className="space-y-2 border-l-2 border-accent-500 pl-3"
        >
          <p>
            Working/final projection.{' '}
            {prepared.record.snapshot.unsaved
              ? 'This context includes your unsaved draft.'
              : 'This context uses the saved manuscript.'}{' '}
            {prepared.record.snapshot.blocks.length} complete paragraphs and{' '}
            {prepared.record.snapshot.codex.length} codex entries included.{' '}
            {prepared.record.snapshot.omitted.blockIds.length} paragraphs and{' '}
            {prepared.record.snapshot.omitted.codexIds.length} codex entries omitted.{' '}
            {prepared.record.snapshot.conversation.length} earlier replies included;{' '}
            {prepared.record.snapshot.omittedProposalIds.length +
              prepared.record.snapshot.omittedEarlierTurnCount}{' '}
            earlier replies omitted.
          </p>
          <details>
            <summary>Review included text</summary>
            {prepared.record.snapshot.conversation.map((turn) => (
              <div key={turn.proposalId} className="space-y-2 border-b border-border-muted py-2">
                <p className="whitespace-pre-wrap">{turn.instruction}</p>
                <p className="whitespace-pre-wrap">{turn.reply}</p>
              </div>
            ))}
            {prepared.record.snapshot.blocks.map((block) => (
              <p key={block.id} className="whitespace-pre-wrap py-2">
                {block.runs.map((run) => run.text).join('')}
              </p>
            ))}
            {prepared.record.snapshot.codex.map((entry) => (
              <p key={entry.id} className="whitespace-pre-wrap py-2">
                <strong>{entry.name}</strong> {entry.text}
              </p>
            ))}
          </details>
          {staleDisclosure && (
            <p role="status">
              The draft has changed. Prepare context again before sending a new request.
            </p>
          )}
          <label className="block space-y-1">
            Instruction
            <textarea
              aria-label="Discussion instruction"
              value={instruction}
              maxLength={8000}
              onChange={(event) => setInstruction(event.target.value)}
              disabled={!!busy}
              className="block min-h-24 w-full rounded border border-border-muted bg-surface-base p-3"
            />
          </label>
          <Button
            type="button"
            onClick={() => void send()}
            disabled={
              disabled ||
              !!busy ||
              staleDisclosure ||
              !instruction.trim() ||
              proposal?.status === 'unknown' ||
              proposal?.status === 'running'
            }
            className="min-h-11"
          >
            Send disclosed context
          </Button>
        </section>
      )}
      {busy && (
        <p role="status">
          {busy === 'infer'
            ? 'Preparing a reply and proposed edits…'
            : busy === 'apply'
              ? 'Saving and revalidating your draft…'
              : 'Loading document context…'}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {(attempt.current || proposal) && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => void recover()}
            className="min-h-11"
          >
            Recover saved response
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void cancel()}
            disabled={proposal?.status === 'applied'}
            className="min-h-11"
          >
            Cancel proposal
          </Button>
        </div>
      )}
      {proposal && (
        <section aria-label="Proposed document edits" className="space-y-3">
          <p role="status">
            {proposal.status === 'unknown'
              ? 'Provider outcome is unknown. This operation will not be repeated automatically.'
              : proposal.status === 'applied'
                ? 'Proposal applied as tracked changes. Resolve those changes separately in the manuscript.'
                : `Proposal ${proposal.status}.`}
          </p>
          {output && (
            <>
              <p className="whitespace-pre-wrap">{output.reply}</p>
              {output.edits.map((edit) => (
                <label
                  key={edit.targetId}
                  className="block space-y-2 rounded border border-border-muted p-3"
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedEdits.includes(edit.targetId)}
                      disabled={!!busy || proposal.status !== 'ready'}
                      onChange={(event) =>
                        setSelectedEdits((ids) =>
                          event.target.checked
                            ? [...ids, edit.targetId]
                            : ids.filter((id) => id !== edit.targetId),
                        )
                      }
                    />
                    Include this proposed edit
                  </span>
                  <del className="block whitespace-pre-wrap text-danger">{edit.sourceText}</del>
                  <ins className="block whitespace-pre-wrap text-success no-underline">
                    {edit.replacement}
                  </ins>
                </label>
              ))}
              <Button
                type="button"
                onClick={() => void apply()}
                disabled={
                  disabled || !!busy || proposal.status !== 'ready' || !selectedEdits.length
                }
                className="min-h-11"
              >
                Save, revalidate and apply selected edits
              </Button>
            </>
          )}
        </section>
      )}
      {!!history.length && (
        <details>
          <summary>Saved discussions</summary>
          <div className="space-y-2 py-2">
            {history.map((record) => (
              <Button
                key={record.id}
                type="button"
                variant="ghost"
                disabled={!!busy}
                onClick={() => void openHistory(record.id)}
                className="min-h-11"
              >
                {new Date(record.createdAt).toLocaleString()}
              </Button>
            ))}
          </div>
          {choices.map((row) => (
            <Button
              key={row.id}
              type="button"
              variant="ghost"
              disabled={!!busy}
              onClick={() => void recover(row.id)}
              className="min-h-11"
            >
              Recover {row.status} proposal
            </Button>
          ))}
        </details>
      )}
    </aside>
  );
}
