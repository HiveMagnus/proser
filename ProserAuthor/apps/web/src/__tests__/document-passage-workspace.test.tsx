import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { defaultLayout, type DocumentPassage } from '@cheftaco/proser-contracts';
import { useLayoutEffect } from 'react';
import { passageDocument } from '@/lib/document-passage-document';
import { DocumentPassageWorkspace } from '@/components/editor/document-passage-workspace';
const mocks = vi.hoisted(() => ({
  snapshot: {} as Record<string, unknown>,
  edit: vi.fn(),
  save: vi.fn(),
  load: vi.fn(),
  operate: vi.fn(),
  discussion: vi.fn(),
  canvasConstruct: vi.fn(),
  canvasDestroy: vi.fn(),
}));
vi.mock('@/hooks/use-document-passage-session', () => ({
  useDocumentPassageSession: () => mocks.snapshot,
}));
vi.mock('@/hooks/use-rejected-document-edit', () => ({
  useRejectedDocumentEdit: () => ({
    pending: false,
    ready: true,
    reject: vi.fn(),
    discard: vi.fn(),
    discardToken: 0,
  }),
}));
vi.mock('@/components/editor/bounded-document-review', () => ({
  BoundedDocumentReview: () => <div>Bounded review</div>,
}));
vi.mock('@/components/editor/document-passage-comments', () => ({
  DocumentPassageComments: () => <div>Passage comments</div>,
}));
vi.mock('@/components/editor/bounded-document-discussion', () => ({
  BoundedDocumentDiscussion: (props: unknown) => {
    mocks.discussion(props);
    return <div>Bounded discussion</div>;
  },
}));
vi.mock('@cheftaco/proser-editor', async (importOriginal) => {
  const original = await importOriginal<typeof import('@cheftaco/proser-editor')>();
  return {
    ...original,
    CanvasDocumentEditor: ({
      document,
      onChange,
      displayLayout,
      onDocumentSelection,
      onInsertTable,
    }: {
      document: import('@cheftaco/proser-contracts').ProserDocument;
      onChange(document: import('@cheftaco/proser-contracts').ProserDocument): void;
      displayLayout?: import('@cheftaco/proser-contracts').DocumentLayout;
      onDocumentSelection(selection: undefined, error?: string): void;
      onInsertTable(selection: import('@cheftaco/proser-editor').DocumentSelection): Promise<void>;
    }) => {
      // Match the native adapter's layout-dependent lifecycle without trying
      // to render a canvas in jsdom. Selection callbacks rerender its owner.
      useLayoutEffect(() => {
        mocks.canvasConstruct(displayLayout);
        return () => mocks.canvasDestroy();
      }, [displayLayout]);
      return (
        <>
          <button onClick={() => onChange(document)}>Canvas fragment editor</button>
          <button
            onClick={() =>
              void onInsertTable({
                projection: 'final',
                targets: [{ blockId: 'p', from: 0, to: 0, sourceText: '' }],
                runs: [],
                container: {},
              })
            }
          >
            Insert toolbar table
          </button>
          <button onClick={() => onDocumentSelection(undefined, 'Selection changed')}>
            Select in Canvas
          </button>
        </>
      );
    },
  };
});
function source(): DocumentPassage {
  const paragraph = {
    type: 'paragraph' as const,
    id: 'p',
    style: {},
    runs: [{ id: 'r', text: 'only this cell', style: { bold: true } }],
  };
  const placement = {
    before: {
      neighborId: 'table',
      neighborHash: 'a'.repeat(64),
      containerHash: 'b'.repeat(64),
      side: 'before' as const,
    },
    after: {
      neighborId: 'table',
      neighborHash: 'a'.repeat(64),
      containerHash: 'b'.repeat(64),
      side: 'after' as const,
    },
  };
  return {
    schemaVersion: 1,
    bookRevisionId: 'book',
    sceneRevisionId: 'scene',
    sceneId: 4,
    contentHash: 'c'.repeat(64),
    projection: 'final',
    cursor: { item: 1, paragraph: 3, offset: 10 },
    windowHash: 'd'.repeat(64),
    layout: defaultLayout(),
    changes: [],
    images: [],
    omitted: { paragraphs: 100000, objects: 5, comments: 0, changes: 0 },
    paragraphs: [
      {
        paragraph,
        paragraphHash: 'e'.repeat(64),
        containerHash: 'f'.repeat(64),
        ordinal: 3,
        offset: 10,
        length: 300000,
        continuedBefore: true,
        continuedAfter: true,
        runs: [{ runId: 'r', sourceHash: '1'.repeat(64), from: 10, to: 24, sourceLength: 300000 }],
        container: {
          tableId: 'table',
          rowId: 'row',
          cellId: 'cell',
          widths: [100, 200, 300],
          rowOrdinal: 5,
          columnIndex: 2,
          cellParagraphOrdinal: 0,
        },
      },
    ],
    items: [
      {
        type: 'tableSlice',
        id: 'table',
        source: { objectId: 'table', sourceHash: '2'.repeat(64), containerHash: '3'.repeat(64) },
        placement,
        blockOrdinal: 1,
        widths: [100, 200, 300],
        rowCount: 500,
        columnCount: 3,
        columnHashes: ['4', '5', '6'],
        continuedBefore: true,
        continuedAfter: true,
        rows: [
          {
            id: 'row',
            ordinal: 5,
            sourceHash: '7'.repeat(64),
            cells: [
              {
                id: 'cell',
                columnIndex: 2,
                paragraphCount: 1,
                continuedBefore: true,
                continuedAfter: true,
                paragraphIndexes: [0],
              },
            ],
          },
        ],
      },
    ],
  };
}
function prepare(passage: DocumentPassage) {
  mocks.snapshot = {
    state: 'saved',
    passage,
    document: passageDocument(passage),
    canUndo: false,
    canRedo: false,
    online: true,
    flush: vi.fn(async () => passage),
    refresh: vi.fn(),
    session: {
      edit: mocks.edit,
      save: mocks.save,
      load: mocks.load,
      operate: mocks.operate,
      localOperations: () => undefined,
      undoRevision: vi.fn(),
      redoRevision: vi.fn(),
      getSnapshot: () => ({ structuralFlight: false, passage }),
    },
  };
}
describe('bounded scene workspace', () => {
  it('places a sliced table cell in its exact original column without invented editable neighbours', () => {
    const passage = source();
    prepare(passage);
    const { container } = render(
      <DocumentPassageWorkspace userId="owner" bookId="1" sceneId="4" actorId={7} />,
    );
    const cells = container.querySelectorAll('[data-source-column]');
    expect(cells).toHaveLength(1);
    expect(cells[0]).toHaveAttribute('data-source-column', '2');
    expect(cells[0]).toHaveStyle({ gridColumn: '3' });
    expect(container.querySelectorAll('[data-source-column] textarea')).toHaveLength(1);
    expect(screen.getByText('Cell continued in an adjacent passage.')).toBeInTheDocument();
    const props = mocks.discussion.mock.lastCall![0] as {
      targets: Array<{ from: number; to: number; sourceText: string }>;
    };
    expect(props.targets).toEqual([
      { blockId: 'p', from: 10, to: 24, sourceText: 'only this cell' },
    ]);
  });
  it('requests original/markup projection from Factory and disables edits when reading them', async () => {
    const passage = source();
    prepare(passage);
    render(<DocumentPassageWorkspace userId="owner" bookId="1" sceneId="4" actorId={7} />);
    fireEvent.change(screen.getByLabelText('Passage review view'), {
      target: { value: 'original' },
    });
    await waitFor(() =>
      expect(mocks.load).toHaveBeenCalledWith({ projection: 'original', cursor: passage.cursor }),
    );
    fireEvent.change(screen.getByLabelText('Passage review view'), {
      target: { value: 'markup' },
    });
    await waitFor(() =>
      expect(mocks.load).toHaveBeenCalledWith({
        projection: 'markup',
        cursor: { paragraph: passage.cursor.paragraph, item: passage.cursor.item, offset: 0 },
      }),
    );
  });
  it('uses the supplied ordered transport for object-only passages', () => {
    const passage = source();
    passage.paragraphs = [];
    passage.items = [
      {
        type: 'pageBreak',
        pageBreak: { type: 'pageBreak', id: 'break' },
        source: { objectId: 'break', sourceHash: 'a'.repeat(64), containerHash: 'b'.repeat(64) },
        blockOrdinal: 0,
        placement: passage.items![0]!.placement,
      },
    ];
    prepare(passage);
    render(<DocumentPassageWorkspace userId="owner" bookId="1" sceneId="4" actorId={7} />);
    expect(screen.getByText('Canvas fragment editor')).toBeInTheDocument();
    expect(passageDocument(passage).blocks).toEqual([{ type: 'pageBreak', id: 'break' }]);
  });
  it('inserts a toolbar table through the acknowledged paragraph placement without changing Canvas text', async () => {
    const passage = source();
    const paragraph = passage.paragraphs[0]!;
    delete paragraph.container;
    paragraph.continuedBefore = false;
    paragraph.continuedAfter = false;
    passage.items = [
      {
        type: 'paragraph',
        paragraphIndex: 0,
        blockOrdinal: 0,
        placement: passage.items![0]!.placement,
      },
    ];
    prepare(passage);
    mocks.operate.mockClear();
    const flush = mocks.snapshot.flush as ReturnType<typeof vi.fn>;
    render(<DocumentPassageWorkspace userId="owner" bookId="1" sceneId="4" actorId={7} />);
    fireEvent.click(screen.getByText('Insert toolbar table'));
    await waitFor(() => expect(mocks.operate).toHaveBeenCalledOnce());
    expect(flush).toHaveBeenCalledOnce();
    expect(mocks.operate).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          kind: 'insert-table',
          placement: passage.items[0]!.placement.after,
          widths: [200, 200],
          rows: 2,
        }),
      ],
      false,
    );
    expect(flush.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.operate.mock.invocationCallOrder[0]!,
    );
  });
  it('retains the native editor on selection/status renders and updates real page changes', () => {
    const passage = source();
    passage.paragraphs = [];
    passage.items = [
      {
        type: 'pageBreak',
        pageBreak: { type: 'pageBreak', id: 'break' },
        source: { objectId: 'break', sourceHash: 'a'.repeat(64), containerHash: 'b'.repeat(64) },
        blockOrdinal: 0,
        placement: passage.items![0]!.placement,
      },
    ];
    prepare(passage);
    mocks.canvasConstruct.mockClear();
    mocks.canvasDestroy.mockClear();
    const props = { userId: 'owner', bookId: '1', sceneId: '4', actorId: 7 };
    const view = render(<DocumentPassageWorkspace {...props} />);
    expect(mocks.canvasConstruct).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Select in Canvas'));
    view.rerender(
      <DocumentPassageWorkspace {...props} sideContext={<p>Updated book context</p>} />,
    );
    expect(mocks.canvasConstruct).toHaveBeenCalledTimes(1);
    expect(mocks.canvasDestroy).not.toHaveBeenCalled();

    const updated = { ...passage, layout: { ...passage.layout, width: passage.layout.width + 30 } };
    prepare(updated);
    view.rerender(<DocumentPassageWorkspace {...props} />);
    expect(mocks.canvasConstruct).toHaveBeenCalledTimes(2);
    expect(mocks.canvasDestroy).toHaveBeenCalledTimes(1);
    expect(mocks.canvasConstruct.mock.lastCall![0].width).toBe(updated.layout.width);
  });
});
