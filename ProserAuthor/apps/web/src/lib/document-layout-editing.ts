import {
  canonicalDocument,
  defaultLayout,
  minimalTextEdit,
  replaceDocumentText,
  type BookLayoutSnapshot,
  type DocumentParagraph,
  type DocumentLayout,
  type ProserDocument,
} from '@cheftaco/proser-contracts';
/** Text settings retain style runs; ambiguous replacements fail visibly. */
export function editLayoutStoryParagraph(
  paragraph: DocumentParagraph,
  text: string,
): DocumentParagraph {
  if (
    paragraph.changeId ||
    paragraph.boundaryChangeId ||
    paragraph.runs.some((run) => run.changeId)
  )
    throw new Error('Resolve this story review before editing its text.');
  const source = paragraph.runs.map((run) => run.text).join('');
  const edit = minimalTextEdit(source, text);
  const document = replaceDocumentText(
    { schemaVersion: 1, blocks: [paragraph], layout: defaultLayout(), changes: [], comments: [] },
    edit.start,
    edit.end,
    source.slice(edit.start, edit.end),
    edit.replacement,
    () => crypto.randomUUID(),
  );
  return document.blocks[0] as DocumentParagraph;
}
export function layoutForChapter(layout: BookLayoutSnapshot, chapterId?: number) {
  return chapterId ? (layout.chapters[String(chapterId)] ?? layout.book) : layout.book;
}
/** Propose property-level reconciliation; the caller must display and approve it. */
export function reconcileLayoutSettings(
  base: BookLayoutSnapshot,
  local: BookLayoutSnapshot,
  saved: BookLayoutSnapshot,
) {
  const conflicts: string[] = [];
  const choose = (a: unknown, b: unknown, c: unknown, path: string): unknown => {
    if (
      canonicalDocument(b) === canonicalDocument(a) ||
      canonicalDocument(b) === canonicalDocument(c)
    )
      return structuredClone(c);
    if (canonicalDocument(c) === canonicalDocument(a)) return structuredClone(b);
    const object = (value: unknown): value is Record<string, unknown> =>
      Boolean(value && typeof value === 'object' && !Array.isArray(value));
    if (object(a) && object(b) && object(c))
      return Object.fromEntries(
        [...new Set([...Object.keys(a), ...Object.keys(b), ...Object.keys(c)])]
          .map((key) => [key, choose(a[key], b[key], c[key], path ? `${path}.${key}` : key)])
          .filter(([, value]) => value !== undefined),
      );
    conflicts.push(path);
    return structuredClone(b);
  };
  return { layout: choose(base, local, saved, '') as BookLayoutSnapshot, conflicts };
}

/** Upgrade an explicitly selected legacy story without rewriting scene layout. */
export function ownHeaderFooterStory(
  layout: BookLayoutSnapshot,
  kind: 'header' | 'footer',
  chapterId?: number,
  id: () => string = () => crypto.randomUUID(),
): BookLayoutSnapshot {
  const next = structuredClone(layout);
  const owner = chapterId ? 'chapter' : 'book';
  if (
    next.headerFooterStories?.some(
      (story) => story.owner === owner && story.chapterId === chapterId && story.kind === kind,
    )
  )
    throw new Error('This scope already owns that story.');
  const settings = chapterId
    ? (next.chapters[String(chapterId)] ??= structuredClone(next.book))
    : next.book;
  const paragraphs = settings[kind];
  const document: ProserDocument = {
    schemaVersion: 1,
    blocks: paragraphs.length
      ? structuredClone(paragraphs)
      : [{ type: 'paragraph', id: id(), style: {}, runs: [{ id: id(), text: '', style: {} }] }],
    layout: { ...structuredClone(settings), header: [], footer: [] },
    changes: [],
    comments: [],
  };
  (next.headerFooterStories ??= []).push({
    id: id(),
    owner,
    ...(chapterId ? { chapterId } : {}),
    kind,
    document,
  });
  settings[kind] = [];
  return next;
}
export function headerFooterForChapter(layout: BookLayoutSnapshot, chapterId?: number) {
  const choose = (kind: 'header' | 'footer') =>
    layout.headerFooterStories?.find(
      (story) => story.kind === kind && story.owner === 'chapter' && story.chapterId === chapterId,
    )?.document ??
    layout.headerFooterStories?.find((story) => story.kind === kind && story.owner === 'book')
      ?.document;
  return { header: choose('header'), footer: choose('footer') };
}
export function storyDisplayLayout(settings: DocumentLayout): DocumentLayout {
  return { ...settings, header: [], footer: [] };
}
