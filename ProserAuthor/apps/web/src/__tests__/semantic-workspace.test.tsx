import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  SemanticDocument,
  documentFromText,
  formatDocumentSelection,
  formatDocumentParagraph,
  type ProserDocument,
} from '@hivemagnus/proser-editor';
let sequence = 0;
const id = () => `semantic-browser-${++sequence}`;
function Workspace({ changed }: { changed: (document: ProserDocument) => void }) {
  const [document, setDocument] = useState(() =>
    documentFromText('First 😀 word\n\nUntouched', id),
  );
  const update = (next: ProserDocument) => {
    setDocument(next);
    changed(next);
  };
  return (
    <SemanticDocument
      document={document}
      editable
      onEditParagraph={(blockId, text) => {
        const next = structuredClone(document);
        const block = next.blocks.find((item) => item.id === blockId);
        if (block?.type === 'paragraph') block.runs[0]!.text = text;
        update(next);
      }}
      onFormatSelection={(selection, patch) =>
        update(formatDocumentSelection(document, selection, patch, id))
      }
      onFormatParagraph={(blockId, patch) =>
        update(formatDocumentParagraph(document, blockId, patch))
      }
    />
  );
}
describe('accessible semantic editing', () => {
  it('retains focus and canonical selection while formatting Unicode text and paragraph style', () => {
    const changed = vi.fn();
    render(<Workspace changed={changed} />);
    const input = screen.getByRole('textbox', { name: 'Paragraph 1' }) as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(6, 8);
    fireEvent.select(input);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Bold' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(6);
    expect(input.selectionEnd).toBe(8);
    const paragraph = changed.mock.lastCall![0].blocks[0];
    expect(paragraph.runs.map((run: { text: string }) => run.text)).toEqual([
      'First ',
      '😀',
      ' word',
    ]);
    expect(paragraph.runs[1].style.bold).toBe(true);
    fireEvent.change(screen.getByRole('combobox', { name: 'Accessible paragraph style' }), {
      target: { value: 'heading2' },
    });
    expect(changed.mock.lastCall![0].blocks[0].style.heading).toBe(2);
    expect(screen.getByRole('textbox', { name: 'Paragraph 2' })).toHaveValue('Untouched');
  });
  it('commits composition only at completion and does not replace the active textarea', () => {
    const changed = vi.fn();
    render(<Workspace changed={changed} />);
    const input = screen.getByRole('textbox', { name: 'Paragraph 1' });
    input.focus();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'First 日本語 word' } });
    expect(changed).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: 'Paragraph 1' })).toBe(input);
    expect(input).toHaveFocus();
    expect(input).toHaveValue('First 日本語 word');
  });
});
