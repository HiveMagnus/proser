import {
  passageRunSpan,
  rebasePassageRunSource,
  type DocumentPassageOperation,
  type PassageRunSource,
  type PassageOperationMapping,
  type PassageStylePatch,
  type TextStyle,
  type DocumentImage,
} from '@hivemagnus/proser-contracts';
export interface FrozenPassageRun {
  source: PassageRunSource;
  text: string;
}
export type PassageRunGesture =
  | { kind: 'text'; replacement: string }
  | { kind: 'run-format'; patch: PassageStylePatch<TextStyle> }
  | { kind: 'paragraph-split' }
  | { kind: 'insert-inline-image'; image: Omit<DocumentImage, 'type' | 'id'> };
/** These same intents serve Canvas and semantic controls; no Canvas command is sent to Factory. */
export function passageRunGesture(
  frozen: FrozenPassageRun,
  from: number,
  to: number,
  gesture: PassageRunGesture,
  id: string,
): DocumentPassageOperation {
  const target = passageRunSpan(frozen.source, frozen.text, from, to);
  if (gesture.kind === 'text')
    return {
      id,
      kind: 'text',
      target,
      expectedText: frozen.text.slice(from, to),
      replacement: gesture.replacement,
    };
  if (gesture.kind === 'run-format')
    return {
      id,
      kind: 'run-format',
      target,
      expectedText: frozen.text.slice(from, to),
      patch: structuredClone(gesture.patch),
    };
  if (from !== to)
    throw new Error('Place an exact caret before splitting or inserting an inline object.');
  if (gesture.kind === 'paragraph-split')
    return { id, kind: 'paragraph-split', target, expectedText: '' };
  return { id, kind: 'insert-inline-image', target, image: structuredClone(gesture.image) };
}
export type DeferredPassageRunBasis =
  | { kind: 'source'; source: PassageRunSource }
  | { kind: 'introduced'; operationId: string; role: string; from: number; to: number };
export interface DeferredPassageRunIntent {
  id: string;
  basis: DeferredPassageRunBasis;
  gesture: PassageRunGesture;
  expectedText: string;
}
export interface PassageMappingReceipt {
  operationMappings: PassageOperationMapping[];
  introducedIds: Array<{ operationId: string; role: string; id: string }>;
}
/** Only authenticated operation mappings may replace a provisional target identity. */
export function materializeDeferredPassageIntent(
  intent: DeferredPassageRunIntent,
  receipt: PassageMappingReceipt,
): DocumentPassageOperation {
  let target: PassageRunSource;
  if (intent.basis.kind === 'source')
    target = rebasePassageRunSource(intent.basis.source, receipt.operationMappings);
  else {
    const basis = intent.basis;
    const introduced = receipt.introducedIds.filter(
      (item) => item.operationId === basis.operationId && item.role === basis.role,
    );
    if (introduced.length !== 1)
      throw new Error('This provisional identity has no unique Factory introduction receipt.');
    const candidates = receipt.operationMappings.filter(
      (mapping) =>
        mapping.operationId === basis.operationId &&
        mapping.target?.runId === introduced[0]!.id &&
        mapping.target.from <= basis.from &&
        mapping.target.to >= basis.to,
    );
    if (
      candidates.length !== 1 ||
      !Number.isSafeInteger(basis.from) ||
      !Number.isSafeInteger(basis.to) ||
      basis.to < basis.from
    )
      throw new Error('This introduced target needs explicit reconciliation.');
    target = { ...candidates[0]!.target!, from: basis.from, to: basis.to };
  }
  if (intent.gesture.kind === 'text')
    return {
      id: intent.id,
      kind: 'text',
      target,
      expectedText: intent.expectedText,
      replacement: intent.gesture.replacement,
    };
  if (intent.gesture.kind === 'run-format')
    return {
      id: intent.id,
      kind: 'run-format',
      target,
      expectedText: intent.expectedText,
      patch: structuredClone(intent.gesture.patch),
    };
  if (target.from !== target.to || intent.expectedText !== '')
    throw new Error('The structural intent no longer has its exact caret.');
  return intent.gesture.kind === 'paragraph-split'
    ? { id: intent.id, kind: 'paragraph-split', target, expectedText: '' }
    : {
        id: intent.id,
        kind: 'insert-inline-image',
        target,
        image: structuredClone(intent.gesture.image),
      };
}
