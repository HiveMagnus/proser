import { describe, expect, it } from 'vitest';
import { documentFromText } from '@hivemagnus/proser-editor';
import {
  appendDocumentHistory,
  initialDocumentHistory,
  recoverDocumentHistory,
} from '@/lib/document-history';
let sequence = 0;
const document = (text: string) => documentFromText(text, () => `history-${++sequence}`);
describe('bounded document operation journal', () => {
  it('drops a redo branch after a new edit and keeps immutable snapshots', () => {
    const before = document('Before');
    const after = document('After');
    let history = appendDocumentHistory(initialDocumentHistory(before), before, after);
    history.cursor = 0;
    const other = document('Other');
    history = appendDocumentHistory(history, before, other);
    expect(history.entries.map((entry) => entry.document)).toEqual([before, other]);
    const block = other.blocks[0];
    if (block?.type === 'paragraph') block.runs[0]!.text = 'Modified outside journal';
    expect(history.entries[1]!.document).not.toEqual(other);
  });
  it('bounds retained operations and refuses a recovery cursor that does not match the draft', () => {
    let current = document('0');
    let history = initialDocumentHistory(current);
    for (let index = 1; index <= 125; index++) {
      const next = document(String(index));
      history = appendDocumentHistory(history, current, next);
      current = next;
    }
    expect(history.entries).toHaveLength(100);
    expect(history.cursor).toBe(99);
    expect(recoverDocumentHistory(history, current)).toEqual(history);
    const unrelated = document('Unrelated');
    const recovered = recoverDocumentHistory(history, unrelated);
    expect(recovered.entries).toHaveLength(1);
    expect(recovered.entries[0]!.document).toEqual(unrelated);
  });
});
