// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SemanticDocument } from '../components/semantic-document';
import { documentFromText, type DocumentParagraph } from '../document-model';
import { paragraphSelection } from '../document-selection';
import { editManualParagraphText } from '../manual-review-editing';
let sequence = 0;
const id = () => `semantic-access-${++sequence}`;
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const document = documentFromText('Heading\n\nBody', id);
  const heading = document.blocks[0] as DocumentParagraph;
  heading.style.heading = 2;
  const body = document.blocks[1] as DocumentParagraph;
  body.runs.push({
    id: id(),
    text: '',
    style: {},
    inlineImage: {
      assetId: 42,
      sha256: 'a'.repeat(64),
      width: 32,
      height: 32,
      alt: 'Ink sketch of a lantern',
    },
  });
  const cell = documentFromText('A😀e\u0301Z', id).blocks[0] as DocumentParagraph;
  cell.style.list = 'number';
  document.blocks.push({
    type: 'table',
    id: 'owned-table',
    widths: [100],
    rows: [{ id: 'owned-row', cells: [{ id: 'owned-cell', paragraphs: [cell] }] }],
  });
  return { document, heading, body, cell };
}
async function mounted(element: React.ReactNode) {
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return {
    host,
    root,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
const description = (input: Element) =>
  window.document.getElementById(input.getAttribute('aria-describedby')!)?.textContent;
describe('semantic editing accessibility and canonical continuity', () => {
  it('exposes heading/list/cell context and protected image descriptions beside text input', async () => {
    const { document } = fixture();
    const { host, cleanup } = await mounted(
      <SemanticDocument document={document} editable showFormattingControls={false} />,
    );
    try {
      expect(host.querySelector('h2')?.textContent).toBe('Heading');
      expect(description(host.querySelector('[aria-label="Paragraph 1"]')!)).toContain(
        'Heading level 2',
      );
      expect(description(host.querySelector('[aria-label="Paragraph 2"]')!)).toContain(
        'protected inline image: Ink sketch of a lantern',
      );
      expect(host.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
        'Ink sketch of a lantern',
      );
      expect(description(host.querySelector('[aria-label="Paragraph 3"]')!)).toContain(
        'Table 1, row 1, column 1',
      );
      expect(description(host.querySelector('[aria-label="Paragraph 3"]')!)).toContain(
        'Numbered list item 1',
      );
      expect(host.querySelector('td ol li')).not.toBeNull();
      expect(host.querySelector('tr')?.getAttribute('data-row-id')).toBe('owned-row');
      expect(host.querySelector('caption')?.textContent).toBe('Manuscript table 1');
    } finally {
      await cleanup();
    }
  });
  it('restores and publishes a Unicode table-cell range after focus, preserving container ownership', async () => {
    const { document, cell } = fixture();
    const selected = paragraphSelection(document, cell.id, 1, 5, 'A😀e\u0301Z')!;
    const onFocusSelection = vi.fn(),
      onSelection = vi.fn();
    const { host, cleanup } = await mounted(
      <SemanticDocument
        document={document}
        editable
        initialSelection={selected}
        onFocusSelection={onFocusSelection}
        onSelection={onSelection}
      />,
    );
    try {
      const input = host.querySelector<HTMLTextAreaElement>('[aria-label="Paragraph 3"]')!;
      expect(window.document.activeElement).toBe(input);
      expect([input.selectionStart, input.selectionEnd]).toEqual([1, 5]);
      expect(onFocusSelection).toHaveBeenLastCalledWith(selected);
      expect(onSelection).toHaveBeenLastCalledWith(selected);
      expect(selected.container).toEqual({
        tableId: 'owned-table',
        rowId: 'owned-row',
        cellId: 'owned-cell',
      });
    } finally {
      await cleanup();
    }
  });
  it('moves between paragraph and table inputs by keyboard without splitting the next grapheme or mutating content', async () => {
    const { document, body, cell } = fixture();
    const onFocusSelection = vi.fn(),
      onEditParagraph = vi.fn();
    const { host, cleanup } = await mounted(
      <SemanticDocument
        document={document}
        editable
        onFocusSelection={onFocusSelection}
        onEditParagraph={onEditParagraph}
      />,
    );
    try {
      const bodyInput = host.querySelector<HTMLTextAreaElement>('[aria-label="Paragraph 2"]')!;
      const cellInput = host.querySelector<HTMLTextAreaElement>('[aria-label="Paragraph 3"]')!;
      await act(async () => {
        bodyInput.focus();
        bodyInput.setSelectionRange(2, 2);
      });
      await act(async () =>
        bodyInput.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            altKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(window.document.activeElement).toBe(cellInput);
      expect([cellInput.selectionStart, cellInput.selectionEnd]).toEqual([1, 1]);
      expect(onFocusSelection.mock.lastCall![0]).toMatchObject({
        targets: [{ blockId: cell.id, from: 1, to: 1, sourceText: '' }],
        container: { tableId: 'owned-table', rowId: 'owned-row', cellId: 'owned-cell' },
      });
      await act(async () =>
        cellInput.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'ArrowUp',
            altKey: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      );
      expect(window.document.activeElement).toBe(bodyInput);
      expect(onFocusSelection.mock.lastCall![0].targets[0].blockId).toBe(body.id);
      expect(onEditParagraph).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });
  it('keeps originals and markup read-only even when editability is requested', async () => {
    const { document } = fixture();
    for (const view of ['original', 'markup'] as const) {
      const { host, cleanup } = await mounted(
        <SemanticDocument document={document} view={view} editable />,
      );
      try {
        expect(host.querySelector('textarea')).toBeNull();
        expect(host.querySelector('table')).not.toBeNull();
      } finally {
        await cleanup();
      }
    }
  });
  it('allows adjacent text editing while preserving protected image, table, and formatting identities', () => {
    const { document, body } = fixture();
    body.runs[0]!.style = { bold: true, font: 'Georgia' };
    const image = structuredClone(body.runs[1]);
    const table = structuredClone(document.blocks[2]);
    const edited = editManualParagraphText(document, body.id, 'Body added\ufffc', 7, false, id);
    expect((edited.blocks[1] as DocumentParagraph).runs.find((run) => run.inlineImage)).toEqual(
      image,
    );
    expect(edited.blocks[2]).toEqual(table);
    expect(
      (edited.blocks[1] as DocumentParagraph).runs
        .filter((run) => !run.inlineImage)
        .every((run) => run.style.bold),
    ).toBe(true);
    expect(() => editManualParagraphText(document, body.id, 'Body', 7, false, id)).toThrow();
  });
  it('releases composition state on unmount without committing partial composition twice', async () => {
    const { document } = fixture();
    const onCompositionState = vi.fn(),
      onEditParagraph = vi.fn();
    const { host, root, cleanup } = await mounted(
      <SemanticDocument
        document={document}
        editable
        onCompositionState={onCompositionState}
        onEditParagraph={onEditParagraph}
      />,
    );
    try {
      const input = host.querySelector('textarea')!;
      await act(async () =>
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })),
      );
      expect(onCompositionState).toHaveBeenLastCalledWith(true);
      await act(async () => root.unmount());
      expect(onCompositionState).toHaveBeenLastCalledWith(false);
      expect(onEditParagraph).not.toHaveBeenCalled();
    } finally {
      await cleanup();
    }
  });
});
