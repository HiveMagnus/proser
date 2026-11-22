import {
  canonicalDocument,
  passageRunSpan,
  type DocumentPassage,
  type PassageRunSource,
} from '@cheftaco/proser-contracts';
import { passageRunSource } from './document-passage-document';
export interface AdjacentPassageRange {
  sceneId: number;
  target: PassageRunSource;
  expectedText: string;
}
/** DOM text is verification evidence, never a locator. Only qualified run/scene
 * identities in the supplied immutable final passages can produce edit targets. */
export function adjacentPassageSelection(
  root: HTMLElement,
  range: Range,
  passages: DocumentPassage[],
): AdjacentPassageRange[] {
  if (range.collapsed || !root.contains(range.commonAncestorContainer))
    throw new Error('Select text inside the adjacent scene preview.');
  for (const object of root.querySelectorAll('img,hr'))
    if (range.intersectsNode(object))
      throw new Error('The adjacent selection crosses a protected object or page break.');
  const result: AdjacentPassageRange[] = [];
  const seen = new Set<string>();
  for (const element of root.querySelectorAll<HTMLElement>('[data-run-id]')) {
    if (!range.intersectsNode(element)) continue;
    const sceneId = Number(element.closest<HTMLElement>('[data-scene-id]')?.dataset.sceneId),
      blockId = element.dataset.blockId,
      runId = element.dataset.runId;
    const passage = passages.find((item) => item.sceneId === sceneId);
    if (!passage || passage.projection !== 'final' || !blockId || !runId)
      throw new Error('The adjacent selection crossed an unowned or read-only surface.');
    const scope = passage.paragraphs.find((item) => item.paragraph.id === blockId),
      run = scope?.paragraph.runs.find((item) => item.id === runId);
    if (!run || run.inlineImage || element.textContent !== run.text)
      throw new Error(
        'The selected run changed or contains a protected object. Select the saved text again.',
      );
    const prefix = (node: Node, offset: number) => {
      const value = document.createRange();
      value.selectNodeContents(element);
      value.setEnd(node, offset);
      return value.toString().length;
    };
    const from = element.contains(range.startContainer)
      ? prefix(range.startContainer, range.startOffset)
      : 0;
    const to = element.contains(range.endContainer)
      ? prefix(range.endContainer, range.endOffset)
      : run.text.length;
    if (to <= from) continue;
    const key = JSON.stringify([sceneId, blockId, runId]);
    if (seen.has(key))
      throw new Error('Duplicate source run renderings cannot locate a selection.');
    seen.add(key);
    result.push({
      sceneId,
      target: passageRunSpan(passageRunSource(passage, blockId, runId), run.text, from, to),
      expectedText: run.text.slice(from, to),
    });
  }
  if (!result.length || new Set(result.map((item) => item.sceneId)).size !== 2)
    throw new Error('Select exact text across both adjacent scene excerpts.');
  if (result.length > 32)
    throw new Error('Select at most thirty-two styled runs before a compound edit.');
  for (const sceneId of new Set(result.map((item) => item.sceneId))) {
    const targets = result.filter((item) => item.sceneId === sceneId),
      passage = passages.find((item) => item.sceneId === sceneId)!;
    const signatures = targets.map((target) => {
      const paragraph = passage.paragraphs.find(
        (item) => item.paragraph.id === target.target.blockId,
      )!;
      return canonicalDocument({
        container: paragraph.container ?? null,
        style: paragraph.paragraph.runs.find((run) => run.id === target.target.runId)!.style,
      });
    });
    if (new Set(signatures).size !== 1)
      throw new Error(
        'This replacement crosses incompatible styles or protected containers in one scene. Select one compatible target per scene.',
      );
  }
  const sceneOrder = [...new Set(result.map((item) => item.sceneId))];
  const indexes = sceneOrder.map((id) => passages.findIndex((item) => item.sceneId === id));
  if (indexes[1] !== indexes[0]! + 1) throw new Error('The scene selection is not contiguous.');
  return result;
}
