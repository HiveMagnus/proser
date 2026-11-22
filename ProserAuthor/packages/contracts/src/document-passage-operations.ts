// Generated from Factory documents/passage-operations-model.ts; edit Factory and run npm run documents:sync.
/** Factory-owned bounded operation intents. Attribution/history is never input. */
import type {
  TextStyle,
  ParagraphStyle,
  DocumentImage,
  DocumentAnchorLineage,
  ProserDocument,
  DocumentChange,
} from './document-model.js';
import type {
  DocumentPassageSourceFrame,
  DocumentPassageCursor,
  DocumentPassage,
} from './document-passages.js';
export interface PassageParagraphSource {
  blockId: string;
  paragraphHash: string;
  containerHash: string;
}
export interface PassageRunSource extends PassageParagraphSource {
  runId: string;
  sourceHash: string;
  from: number;
  to: number;
}
export interface PassageObjectSource {
  objectId: string;
  sourceHash: string;
  containerHash: string;
}
export interface PassageBodyPlacement {
  neighborId: string;
  neighborHash: string;
  side: 'before' | 'after';
  containerHash: string;
}
export interface PassageStylePatch<T> {
  set?: Partial<T>;
  unset?: Array<keyof T>;
}
export type DocumentPassageOperation =
  | {
      id: string;
      kind: 'text';
      target: PassageRunSource;
      expectedText: string;
      replacement: string;
    }
  | {
      id: string;
      kind: 'run-format';
      target: PassageRunSource;
      expectedText: string;
      patch: PassageStylePatch<TextStyle>;
    }
  | {
      id: string;
      kind: 'paragraph-format';
      target: PassageParagraphSource;
      patch: PassageStylePatch<ParagraphStyle>;
    }
  | {
      id: string;
      kind: 'paragraph-split';
      target: PassageRunSource;
      expectedText: '';
    }
  | {
      id: string;
      kind: 'paragraph-join';
      left: PassageParagraphSource;
      right: PassageParagraphSource;
      boundaryHash: string;
    }
  | {
      id: string;
      kind: 'insert-inline-image';
      target: PassageRunSource;
      image: Omit<DocumentImage, 'id' | 'type'>;
    }
  | {
      id: string;
      kind: 'insert-image';
      placement: PassageBodyPlacement;
      image: Omit<DocumentImage, 'id' | 'type'>;
    }
  | {
      id: string;
      kind: 'update-image';
      target: PassageObjectSource;
      image: Omit<DocumentImage, 'id' | 'type'>;
    }
  | { id: string; kind: 'remove-object'; target: PassageObjectSource }
  | { id: string; kind: 'insert-break'; placement: PassageBodyPlacement }
  | {
      id: string;
      kind: 'insert-paragraph';
      placement: PassageBodyPlacement;
      style?: ParagraphStyle;
    }
  | {
      id: string;
      kind: 'insert-table';
      placement: PassageBodyPlacement;
      widths: number[];
      rows: number;
    }
  | {
      id: string;
      kind: 'table-widths';
      target: PassageObjectSource;
      widths: number[];
    }
  | {
      id: string;
      kind: 'table-insert-row';
      target: PassageObjectSource;
      rowId: string;
      side: 'before' | 'after';
    }
  | {
      id: string;
      kind: 'table-remove-row';
      target: PassageObjectSource;
      rowId: string;
      rowHash: string;
    }
  | {
      id: string;
      kind: 'table-insert-column';
      target: PassageObjectSource;
      column: number;
      width: number;
    }
  | {
      id: string;
      kind: 'table-remove-column';
      target: PassageObjectSource;
      column: number;
      columnHash: string;
    }
  | {
      id: string;
      kind: 'resolve-change';
      changeId: string;
      changeHash: string;
      targetHash: string;
      decision: 'accepted' | 'rejected';
    };
export interface DocumentPassageOperationCommit {
  schemaVersion: 1;
  operationId: string;
  expectedRevisionId: string;
  expectedSceneRevisionId: string;
  sourceFrame: DocumentPassageSourceFrame;
  windowHash: string;
  cursor: DocumentPassageCursor;
  maxCharacters?: number;
  maxParagraphs?: number;
  maxRuns?: number;
  reviewOffset?: number;
  tracking?: boolean;
  operations: DocumentPassageOperation[];
}
export interface DocumentPassageScopeCommit extends Omit<
  DocumentPassageOperationCommit,
  'schemaVersion' | 'operationId' | 'expectedRevisionId'
> {
  sceneId: number;
}
export interface DocumentPassageBookCommit {
  schemaVersion: 1;
  operationId: string;
  expectedRevisionId: string;
  scenes: DocumentPassageScopeCommit[];
}
export interface DocumentPassageBookAcknowledgement {
  passages: DocumentPassageOperationAcknowledgement[];
}
/** Authenticated operation output coordinates, distinct from unchanged anchor
 * lineage. Hashes must be regenerated against the committed stamped document. */
export interface PassageOperationMapping {
  operationId: string;
  kind: DocumentPassageOperation['kind'];
  relation: 'unchanged' | 'formatted' | 'replacement' | 'inserted' | 'deleted' | 'moved';
  source: PassageRunSource;
  target?: PassageRunSource;
  sourceTextHash: string;
  targetTextHash?: string;
}
export interface DocumentPassageOperationResult {
  document: ProserDocument;
  anchorLineage: DocumentAnchorLineage[];
  operationMappings: PassageOperationMapping[];
  introducedIds: Array<{ operationId: string; role: string; id: string }>;
  touched: {
    blockIds: string[];
    runIds: string[];
    objectIds: string[];
    changeIds: string[];
  };
}
/** The canonical document is server-only; clients receive a bounded committed window. */
export interface DocumentPassageOperationAcknowledgement {
  passage: DocumentPassage;
  operationMappings: PassageOperationMapping[];
  introducedIds: DocumentPassageOperationResult['introducedIds'];
  touched: DocumentPassageOperationResult['touched'];
}
/** Bounded summaries do not discard their complete server-owned record. */
export interface PassageChangeSummary {
  id: string;
  kind: DocumentChange['kind'];
  status: DocumentChange['status'];
  authorId: number;
  authorName: string;
  origin: DocumentChange['origin'];
  createdAt: string;
  recordHash: string;
  targetHash: string;
  targetRunCount: number;
  targetBlockCount: number;
  resolutionCount: number;
  visibleRunIds: string[];
  visibleBlockIds: string[];
  continuedOutsideWindow: boolean;
}
export interface PassageReviewPageRequest {
  expectedSceneRevisionId: string;
  changeId: string;
  recordHash: string;
  offset?: number;
  limit?: number;
}
export interface PassageReviewPage {
  changeId: string;
  recordHash: string;
  offset: number;
  total: number;
  items: NonNullable<DocumentChange['resolutionHistory']>;
  nextOffset?: number;
}
/** Translate a displayed run slice through its supplied immutable source
 * coordinates. This does not validate/mutate saved authority. */
export function passageRunSpan(
  source: PassageRunSource,
  visibleText: string,
  from: number,
  to: number,
): PassageRunSource {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to < from ||
    to > visibleText.length ||
    visibleText.length !== source.to - source.from
  )
    throw new Error('Passage selection exceeds its displayed immutable run slice.');
  const bounds = new Set([
    0,
    visibleText.length,
    ...Array.from(
      new Intl.Segmenter('und', { granularity: 'grapheme' }).segment(visibleText),
      (entry) => entry.index,
    ),
  ]);
  if (!bounds.has(from) || !bounds.has(to))
    throw new Error('Passage selection splits a Unicode grapheme.');
  return { ...source, from: source.from + from, to: source.from + to };
}

/** Rebase a later qualified intent only through an exact, affine operation
 * receipt. Changed/replaced spans and ambiguous boundary carets remain conflicts.
 * Created output spans use their returned operation mapping directly. */
export function rebasePassageRunSource(
  source: PassageRunSource,
  mappings: PassageOperationMapping[],
): PassageRunSource {
  const candidates = mappings.filter(
    (mapping) =>
      mapping.target &&
      ['unchanged', 'formatted', 'moved'].includes(mapping.relation) &&
      mapping.source.blockId === source.blockId &&
      mapping.source.runId === source.runId &&
      mapping.source.sourceHash === source.sourceHash &&
      mapping.source.paragraphHash === source.paragraphHash &&
      mapping.source.containerHash === source.containerHash &&
      mapping.source.from <= source.from &&
      mapping.source.to >= source.to,
  );
  if (candidates.length !== 1)
    throw new Error(
      'Passage intent has no unique exact operation mapping; retain it for reconciliation.',
    );
  const mapping = candidates[0]!,
    target = mapping.target!;
  if (target.to - target.from !== mapping.source.to - mapping.source.from)
    throw new Error('Passage operation mapping is not an affine unchanged-text span.');
  return {
    ...target,
    from: target.from + source.from - mapping.source.from,
    to: target.from + source.to - mapping.source.from,
  };
}
