'use client';
import {
  createElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useId,
  type CSSProperties,
} from 'react';
import { paragraphSelection, type DocumentSelection } from '../document-selection';
import {
  effectiveTextStyle,
  effectiveParagraphStyle,
  type DocumentStyleDefinitions,
  paragraphBoundaryVisible,
  paragraphGroups,
  visibleParagraph,
  visibleRun,
  type DocumentParagraph,
  type ProserDocument,
  type DocumentView,
  type TextStyle,
  type ParagraphStyle,
} from '../document-model';

export interface SemanticDocumentProps {
  document: ProserDocument;
  view?: DocumentView;
  namedStyles?: DocumentStyleDefinitions;
  editable?: boolean;
  showFormattingControls?: boolean;
  onEditParagraph?: (blockId: string, text: string) => boolean | void;
  onCompositionState?: (pending: boolean) => void;
  typography?: { font: string; size: number };
  onFormatSelection?: (selection: DocumentSelection, patch: Partial<TextStyle>) => void;
  onFormatParagraph?: (blockId: string, patch: Partial<ParagraphStyle>) => void;
  initialSelection?: DocumentSelection;
  onFocusSelection?: (selection: DocumentSelection | undefined) => void;
  onSelection?: (selection: DocumentSelection | undefined, error?: string) => void;
}
type ParagraphContext = {
  table?: { number: number; row: number; column: number };
  list?: { kind: 'bullet' | 'number'; index: number };
};
const safeLink = (value?: string) =>
  value && /^(https?:\/\/|mailto:|#)/i.test(value) ? value : undefined;
/** Semantic rendering never evaluates manuscript HTML or loads external assets.
 * Tables keep their actual row/cell topology and all edits use canonical IDs. */
export function SemanticDocument({
  document,
  view = 'final',
  namedStyles,
  editable: requestedEditable = false,
  showFormattingControls = true,
  onEditParagraph,
  onCompositionState,
  typography,
  onSelection,
  initialSelection,
  onFocusSelection,
  onFormatSelection,
  onFormatParagraph,
}: SemanticDocumentProps) {
  const editable = requestedEditable && view === 'final';
  const descriptionPrefix = useId();
  const host = useRef<HTMLElement>(null);
  const compositionCallback = useRef(onCompositionState);
  compositionCallback.current = onCompositionState;
  const [selection, setSelection] = useState<DocumentSelection>();
  const [activeBlock, setActiveBlock] = useState<string>();
  const [compositionPending, setCompositionPending] = useState(false);
  const composing = useRef(new Set<string>());
  const inputs = useRef(new Map<string, HTMLTextAreaElement>());
  const restoring = useRef(false);
  const remembered = useRef<{ blockId: string; from: number; to: number } | undefined>(undefined);
  useEffect(
    () => () => {
      if (composing.current.size) {
        composing.current.clear();
        compositionCallback.current?.(false);
      }
    },
    [],
  );
  useEffect(() => {
    const paragraphs = document.blocks.flatMap((block) =>
      block.type === 'paragraph'
        ? [block]
        : block.type === 'table'
          ? block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.paragraphs))
          : [],
    );
    for (const paragraph of paragraphs) {
      const input = inputs.current.get(paragraph.id);
      if (input && !composing.current.has(paragraph.id)) {
        const value = paragraph.runs
          .filter((run) => visibleRun(run, document.changes, view))
          .map((run) => (run.inlineImage ? '\ufffc' : run.text))
          .join('');
        if (input.value !== value) input.value = value;
      }
    }
    const target = remembered.current;
    const input = target && inputs.current.get(target.blockId);
    if (input && document.blocks.length && globalThis.document.activeElement === input) {
      input.setSelectionRange(
        Math.min(target.from, input.value.length),
        Math.min(target.to, input.value.length),
      );
    }
  }, [document, view]);
  useLayoutEffect(() => {
    if (!editable || view !== 'final' || !initialSelection?.targets.length) return;
    const first = initialSelection.targets[0]!;
    const input = inputs.current.get(first.blockId);
    if (!input) {
      onSelection?.(undefined, 'The saved selection is outside this semantic document.');
      return;
    }
    try {
      for (const target of initialSelection.targets) {
        const field = inputs.current.get(target.blockId);
        if (!field) throw new Error('The selected paragraph changed. Select it again.');
        const verified = paragraphSelection(
          document,
          target.blockId,
          target.from,
          target.to,
          field.value,
          true,
        );
        if (
          !verified ||
          field.value.slice(target.from, target.to) !== target.sourceText ||
          ['tableId', 'rowId', 'cellId'].some(
            (key) =>
              verified.container[key as keyof typeof verified.container] !==
              initialSelection.container[key as keyof typeof initialSelection.container],
          )
        )
          throw new Error('The saved selection changed its text or container. Select it again.');
      }
      restoring.current = true;
      remembered.current = { blockId: first.blockId, from: first.from, to: first.to };
      setActiveBlock(first.blockId);
      setSelection(
        initialSelection.targets.some((target) => target.from !== target.to)
          ? initialSelection
          : undefined,
      );
      input.focus({ preventScroll: true });
      input.setSelectionRange(first.from, first.to);
      // Focusing a textarea reports its previous caret before restoring the
      // range. Publish the verified canonical range after the DOM restoration.
      onFocusSelection?.(initialSelection);
      onSelection?.(
        initialSelection.targets.some((target) => target.from !== target.to)
          ? initialSelection
          : undefined,
      );
      const timeout = setTimeout(() => {
        restoring.current = false;
      }, 0);
      return () => {
        clearTimeout(timeout);
        restoring.current = false;
      };
    } catch (error) {
      onSelection?.(
        undefined,
        error instanceof Error ? error.message : 'Unable to restore this selection.',
      );
    }
  }, [initialSelection, editable, view]);
  const activeParagraph = document.blocks
    .flatMap((block) =>
      block.type === 'paragraph'
        ? [block]
        : block.type === 'table'
          ? block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.paragraphs))
          : [],
    )
    .find((paragraph) => paragraph.id === activeBlock);
  const activeStyle = activeParagraph
    ? effectiveParagraphStyle(activeParagraph, document, view, namedStyles)
    : undefined;
  let paragraphNumber = 0;
  const paragraph = (
    block: DocumentParagraph,
    members: DocumentParagraph[] = [block],
    suppressPreview = false,
    context: ParagraphContext = {},
  ) => {
    if (!visibleParagraph(block, document.changes, view)) return null;
    const number = ++paragraphNumber;
    const runs = block.runs.filter((run) => visibleRun(run, document.changes, view));
    const effective = effectiveParagraphStyle(block, document, view, namedStyles);
    const descriptionId = `${descriptionPrefix}-paragraph-${number}`;
    const objects = runs.flatMap((run) => (run.inlineImage ? [run.inlineImage] : []));
    const hyperlinks = [
      ...new Set(
        runs.flatMap((run) => {
          const href = safeLink(
            effectiveTextStyle(run, block, document, view, namedStyles).hyperlink,
          );
          return href ? [href] : [];
        }),
      ),
    ];
    const description = [
      effective.heading && `Heading level ${effective.heading}.`,
      context.list &&
        `${context.list.kind === 'number' ? 'Numbered' : 'Bulleted'} list item ${context.list.index}.`,
      context.table &&
        `Table ${context.table.number}, row ${context.table.row}, column ${context.table.column}.`,
      objects.length &&
        `Contains ${objects.length === 1 ? 'a protected inline image' : `${objects.length} protected inline images`}: ${objects.map((image) => image.alt || 'Image without a description').join('; ')}. Keep the image marker in the text; image changes use the manuscript object controls.`,
      hyperlinks.length &&
        `Contains ${hyperlinks.length === 1 ? 'a hyperlink' : 'hyperlinks'} to ${hyperlinks.join('; ')}.`,
      'Use Alt+Up or Alt+Down to move between paragraphs.',
    ]
      .filter(Boolean)
      .join(' ');
    const style: CSSProperties = {
      whiteSpace: 'pre-wrap',
      textAlign: effective.alignment,
      marginTop: effective.before,
      marginBottom: effective.after,
      paddingLeft: effective.indent,
      textIndent: effective.firstLineIndent,
      lineHeight: effective.lineSpacing,
      breakBefore: effective.pageBreakBefore ? 'page' : undefined,
      breakAfter: effective.keepWithNext ? 'avoid' : undefined,
    };
    const content = members
      .flatMap((member) =>
        member.runs
          .filter((run) => visibleRun(run, document.changes, view))
          .map((run) => ({ run, member })),
      )
      .map(({ run, member }) => {
        const format = effectiveTextStyle(run, member, document, view, namedStyles);
        const change = document.changes.find(
          (item) => item.id === (run.changeId ?? member.changeId),
        );
        const review = view === 'markup' && change?.status === 'pending';
        const tag =
          review && ['deletion', 'paragraphDeletion'].includes(change.kind)
            ? 'del'
            : review && ['insertion', 'paragraphInsertion'].includes(change.kind)
              ? 'ins'
              : 'span';
        const content = createElement(
          tag,
          {
            key: run.id,
            'data-run-id': run.id,
            'data-block-id': member.id,
            style: {
              fontFamily: typography?.font ?? format.font,
              fontSize: typography?.size ?? format.size,
              fontWeight: format.bold === undefined ? undefined : format.bold ? 'bold' : 'normal',
              fontStyle:
                format.italic === undefined ? undefined : format.italic ? 'italic' : 'normal',
              textDecoration:
                [format.underline && 'underline', format.strikeout && 'line-through']
                  .filter(Boolean)
                  .join(' ') || undefined,
              color: format.color,
              backgroundColor: format.highlight,
            },
          },
          run.inlineImage ? (
            <img
              src={`/api/images/${run.inlineImage.assetId}/content`}
              alt={run.inlineImage.alt}
              width={run.inlineImage.width}
              height={run.inlineImage.height}
              loading="lazy"
              style={{ display: 'inline-block', maxWidth: '100%', verticalAlign: 'baseline' }}
            />
          ) : (
            run.text
          ),
        );
        const href = editable ? undefined : safeLink(format.hyperlink);
        return href ? (
          <a key={run.id} href={href} rel="noreferrer">
            {content}
          </a>
        ) : (
          content
        );
      });
    const tag = effective.heading ? `h${effective.heading}` : 'p';
    return (
      <div key={block.id} data-block-id={block.id}>
        {!suppressPreview &&
          createElement(
            tag,
            { style, 'aria-hidden': (editable && !effective.heading) || undefined },
            content,
          )}
        {editable && (
          <label className="block">
            {effective.heading ? `Heading ${effective.heading}` : `Paragraph ${number}`}
            <span id={descriptionId} className="sr-only">
              {description}
            </span>
            <textarea
              aria-label={`Paragraph ${number}`}
              aria-describedby={descriptionId}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              data-editor-paragraph={block.id}
              ref={(input) => {
                if (input) inputs.current.set(block.id, input);
                else inputs.current.delete(block.id);
              }}
              defaultValue={runs.map((run) => (run.inlineImage ? '\ufffc' : run.text)).join('')}
              onFocus={(event) => {
                setActiveBlock(block.id);
                try {
                  onFocusSelection?.(
                    paragraphSelection(
                      document,
                      block.id,
                      event.currentTarget.selectionStart,
                      event.currentTarget.selectionEnd,
                      event.currentTarget.value,
                      true,
                    ),
                  );
                } catch {
                  onFocusSelection?.(undefined);
                }
              }}
              onCompositionStart={() => {
                composing.current.add(block.id);
                setCompositionPending(true);
                onCompositionState?.(true);
              }}
              onCompositionEnd={(event) => {
                if (!composing.current.delete(block.id)) return;
                remembered.current = {
                  blockId: block.id,
                  from: event.currentTarget.selectionStart,
                  to: event.currentTarget.selectionEnd,
                };
                if (onEditParagraph?.(block.id, event.currentTarget.value) === false)
                  event.currentTarget.value = runs
                    .map((run) => (run.inlineImage ? '\ufffc' : run.text))
                    .join('');
                setCompositionPending(composing.current.size > 0);
                onCompositionState?.(composing.current.size > 0);
              }}
              onBlur={(event) => {
                if (!composing.current.has(block.id) && !restoring.current) {
                  try {
                    onFocusSelection?.(
                      paragraphSelection(
                        document,
                        block.id,
                        event.currentTarget.selectionStart,
                        event.currentTarget.selectionEnd,
                        event.currentTarget.value,
                        true,
                      ),
                    );
                  } catch {
                    onFocusSelection?.(undefined);
                  }
                }
                if (!composing.current.delete(block.id)) return;
                remembered.current = {
                  blockId: block.id,
                  from: event.currentTarget.selectionStart,
                  to: event.currentTarget.selectionEnd,
                };
                if (onEditParagraph?.(block.id, event.currentTarget.value) === false)
                  event.currentTarget.value = runs
                    .map((run) => (run.inlineImage ? '\ufffc' : run.text))
                    .join('');
                setCompositionPending(composing.current.size > 0);
                onCompositionState?.(composing.current.size > 0);
              }}
              onChange={(event) => {
                remembered.current = {
                  blockId: block.id,
                  from: event.target.selectionStart,
                  to: event.target.selectionEnd,
                };
                if (
                  !composing.current.has(block.id) &&
                  onEditParagraph?.(block.id, event.target.value) === false
                )
                  event.target.value = runs
                    .map((run) => (run.inlineImage ? '\ufffc' : run.text))
                    .join('');
              }}
              onSelect={(event) => {
                if (view !== 'final' || composing.current.has(block.id) || restoring.current)
                  return;
                const input = event.currentTarget;
                try {
                  const next = paragraphSelection(
                    document,
                    block.id,
                    input.selectionStart,
                    input.selectionEnd,
                    input.value,
                  );
                  remembered.current = {
                    blockId: block.id,
                    from: input.selectionStart,
                    to: input.selectionEnd,
                  };
                  setSelection(next);
                  onFocusSelection?.(
                    paragraphSelection(
                      document,
                      block.id,
                      input.selectionStart,
                      input.selectionEnd,
                      input.value,
                      true,
                    ),
                  );
                  onSelection?.(next);
                } catch (error) {
                  setSelection(undefined);
                  onFocusSelection?.(undefined);
                  onSelection?.(
                    undefined,
                    error instanceof Error ? error.message : 'Unable to map this selection.',
                  );
                }
              }}
              onKeyDown={(event) => {
                if (
                  !event.altKey ||
                  event.ctrlKey ||
                  event.metaKey ||
                  event.shiftKey ||
                  !['ArrowUp', 'ArrowDown'].includes(event.key) ||
                  event.nativeEvent.isComposing ||
                  composing.current.size
                )
                  return;
                const fields = Array.from(
                  host.current?.querySelectorAll<HTMLTextAreaElement>(
                    'textarea[data-editor-paragraph]',
                  ) ?? [],
                );
                const index = fields.indexOf(event.currentTarget);
                const next = fields[index + (event.key === 'ArrowUp' ? -1 : 1)];
                if (!next) return;
                event.preventDefault();
                const requested = Math.min(event.currentTarget.selectionStart, next.value.length);
                let offset = 0;
                for (const { index, segment } of new Intl.Segmenter(undefined, {
                  granularity: 'grapheme',
                }).segment(next.value)) {
                  const end = index + segment.length;
                  if (end > requested) break;
                  offset = end;
                }
                const blockId = next.dataset.editorParagraph!;
                try {
                  const caret = paragraphSelection(
                    document,
                    blockId,
                    offset,
                    offset,
                    next.value,
                    true,
                  )!;
                  next.focus();
                  next.setSelectionRange(offset, offset);
                  remembered.current = { blockId, from: offset, to: offset };
                  setActiveBlock(blockId);
                  setSelection(undefined);
                  onFocusSelection?.(caret);
                  onSelection?.(undefined);
                } catch (error) {
                  onFocusSelection?.(undefined);
                  onSelection?.(
                    undefined,
                    error instanceof Error
                      ? error.message
                      : 'This paragraph changed. Select it again.',
                  );
                }
              }}
              className="block min-h-28 w-full rounded border p-3"
            />
            {!effective.heading && objects.length > 0 && (
              <span className="sr-only">
                {objects.map((image, index) => (
                  <span
                    key={index}
                    role="img"
                    aria-label={image.alt || 'Image without a description'}
                  />
                ))}
              </span>
            )}
          </label>
        )}
      </div>
    );
  };
  const groupAt = (index: number) => {
    const first = document.blocks[index];
    if (first?.type !== 'paragraph') throw new Error('Paragraph group starts outside a paragraph.');
    const group = [first];
    while (document.blocks[index + 1]?.type === 'paragraph') {
      const next = document.blocks[index + 1] as DocumentParagraph;
      if (paragraphBoundaryVisible(group.at(-1)!, next, document.changes, view)) break;
      group.push(next);
      index++;
    }
    return { group, end: index };
  };
  const renderGroup = (group: DocumentParagraph[], context: ParagraphContext = {}) => (
    <div key={group[0]!.id} data-logical-paragraph>
      {paragraph(group[0]!, group, false, context)}
      {editable && group.slice(1).map((block) => paragraph(block, [block], true, context))}
    </div>
  );
  const renderCellGroups = (groups: DocumentParagraph[][], context: ParagraphContext) => {
    const result = [];
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index]!;
      const kind = effectiveParagraphStyle(group[0]!, document, view, namedStyles).list;
      if (!kind) {
        result.push(renderGroup(group, context));
        continue;
      }
      const items = [];
      while (
        index < groups.length &&
        effectiveParagraphStyle(groups[index]![0]!, document, view, namedStyles).list === kind
      ) {
        const current = groups[index]!;
        items.push(
          <li key={current[0]!.id}>
            {renderGroup(current, { ...context, list: { kind, index: items.length + 1 } })}
          </li>,
        );
        index++;
      }
      index--;
      result.push(
        createElement(
          kind === 'number' ? 'ol' : 'ul',
          {
            key: group[0]!.id,
            className: 'ml-6 list-outside',
            style: { listStyleType: kind === 'number' ? 'decimal' : 'disc' },
          },
          items,
        ),
      );
    }
    return result;
  };
  const nodes = [];
  let tableNumber = 0;
  for (let index = 0; index < document.blocks.length; index++) {
    const block = document.blocks[index]!;
    if (
      block.type === 'paragraph' &&
      effectiveParagraphStyle(block, document, view, namedStyles).list
    ) {
      const kind = effectiveParagraphStyle(block, document, view, namedStyles).list!;
      const items = [];
      while (index < document.blocks.length) {
        const item = document.blocks[index]!;
        if (
          item.type !== 'paragraph' ||
          effectiveParagraphStyle(item, document, view, namedStyles).list !== kind
        ) {
          index--;
          break;
        }
        const grouped = groupAt(index);
        const content = renderGroup(grouped.group, { list: { kind, index: items.length + 1 } });
        if (content) items.push(<li key={item.id}>{content}</li>);
        index = grouped.end + 1;
      }
      nodes.push(
        createElement(
          kind === 'number' ? 'ol' : 'ul',
          {
            key: block.id,
            className: 'ml-6 list-outside',
            style: { listStyleType: kind === 'number' ? 'decimal' : 'disc' },
          },
          items,
        ),
      );
    } else if (block.type === 'paragraph') {
      const grouped = groupAt(index);
      nodes.push(renderGroup(grouped.group));
      index = grouped.end;
    } else if (block.type === 'image')
      nodes.push(
        <figure key={block.id} data-block-id={block.id}>
          <img
            src={`/api/images/${block.assetId}/content`}
            alt={block.alt}
            width={block.width}
            height={block.height}
            loading="lazy"
            style={{ maxWidth: '100%', height: 'auto' }}
          />
        </figure>,
      );
    else if (block.type === 'pageBreak') nodes.push(<hr key={block.id} aria-label="Page break" />);
    else {
      const number = ++tableNumber;
      nodes.push(
        <div
          key={block.id}
          className="overflow-x-auto focus-visible:outline-2"
          tabIndex={0}
          role="region"
          aria-label={`Manuscript table ${number} scroll area`}
        >
          <table
            data-block-id={block.id}
            className="border-collapse"
            style={{
              width: block.widths.reduce((sum, width) => sum + width, 0),
              maxWidth: '100%',
              tableLayout: 'fixed',
            }}
          >
            <colgroup>
              {block.widths.map((width, index) => (
                <col key={index} style={{ width }} />
              ))}
            </colgroup>
            <caption className="sr-only">Manuscript table {number}</caption>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={row.id} data-row-id={row.id}>
                  {row.cells.map((cell, columnIndex) => (
                    <td key={cell.id} data-cell-id={cell.id} className="border p-2 align-top">
                      {renderCellGroups(paragraphGroups(cell.paragraphs, document.changes, view), {
                        table: { number, row: rowIndex + 1, column: columnIndex + 1 },
                      })}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    }
  }
  return (
    <article
      ref={host}
      aria-label="Semantic manuscript"
      className="space-y-4 p-4"
      style={{
        fontFamily: typography?.font ?? document.layout.font,
        fontSize: typography?.size ?? document.layout.fontSize,
      }}
    >
      {editable && showFormattingControls && (onFormatSelection || onFormatParagraph) && (
        <div
          role="toolbar"
          aria-label="Accessible formatting"
          className="sticky top-0 flex flex-wrap gap-2 rounded border bg-surface-raised p-2"
        >
          {(['bold', 'italic', 'underline', 'strikeout'] as const).map((name) => (
            <button
              key={name}
              type="button"
              disabled={!selection || compositionPending}
              className="min-h-11 rounded border px-3"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selection && onFormatSelection?.(selection, { [name]: true })}
            >
              {name === 'strikeout' ? 'Strikeout' : name[0]!.toUpperCase() + name.slice(1)}
            </button>
          ))}
          <button
            type="button"
            disabled={!selection || compositionPending}
            className="min-h-11 rounded border px-3"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() =>
              selection &&
              onFormatSelection?.(selection, {
                bold: false,
                italic: false,
                underline: false,
                strikeout: false,
                highlight: undefined,
              })
            }
          >
            Clear emphasis
          </button>
          <label>
            Font{' '}
            <select
              aria-label="Accessible font"
              disabled={!selection || compositionPending}
              defaultValue=""
              className="min-h-11 rounded border px-2"
              onChange={(event) =>
                selection && onFormatSelection?.(selection, { font: event.target.value })
              }
            >
              <option value="" disabled>
                Choose font
              </option>
              {[
                'Liberation Serif',
                'Liberation Sans',
                'DejaVu Serif',
                'DejaVu Sans',
                'Georgia',
                'Arial',
                'Times New Roman',
                'Courier New',
              ].map((font) => (
                <option key={font}>{font}</option>
              ))}
            </select>
          </label>
          <label>
            Size{' '}
            <input
              aria-label="Accessible font size"
              type="number"
              min={6}
              max={144}
              defaultValue={document.layout.fontSize}
              disabled={!selection || compositionPending}
              className="min-h-11 w-20 rounded border px-2"
              onChange={(event) => {
                const size = Number(event.target.value);
                if (selection && Number.isFinite(size) && size >= 6 && size <= 144)
                  onFormatSelection?.(selection, { size });
              }}
            />
          </label>
          <label>
            Paragraph style{' '}
            <select
              aria-label="Accessible paragraph style"
              disabled={!activeBlock || compositionPending}
              value={
                activeParagraph
                  ? activeStyle?.heading
                    ? `heading${activeStyle.heading}`
                    : (activeStyle?.list ?? 'body')
                  : ''
              }
              className="min-h-11 rounded border px-2"
              onChange={(event) => {
                if (!activeBlock) return;
                const value = event.target.value;
                onFormatParagraph?.(activeBlock, {
                  name: value.startsWith('heading') ? `Heading${value.slice(-1)}` : 'Normal',
                  heading: value.startsWith('heading')
                    ? (Number(value.slice(-1)) as ParagraphStyle['heading'])
                    : undefined,
                  list: value === 'number' || value === 'bullet' ? value : undefined,
                });
              }}
            >
              <option value="" disabled>
                Choose style
              </option>
              <option value="body">Body</option>
              {[1, 2, 3, 4, 5, 6].map((level) => (
                <option key={level} value={`heading${level}`}>
                  Heading {level}
                </option>
              ))}
              <option value="bullet">Bulleted list</option>
              <option value="number">Numbered list</option>
            </select>
          </label>
          <label>
            Alignment{' '}
            <select
              aria-label="Accessible alignment"
              disabled={!activeBlock || compositionPending}
              value={activeStyle?.alignment ?? 'left'}
              className="min-h-11 rounded border px-2"
              onChange={(event) =>
                activeBlock &&
                onFormatParagraph?.(activeBlock, {
                  alignment: event.target.value as ParagraphStyle['alignment'],
                })
              }
            >
              {['left', 'center', 'right', 'justify'].map((alignment) => (
                <option key={alignment}>{alignment}</option>
              ))}
            </select>
          </label>
          {(['color', 'highlight'] as const).map((property) => (
            <label key={property}>
              {property === 'color' ? 'Text color' : 'Highlight'}{' '}
              <input
                type="color"
                aria-label={`Accessible ${property}`}
                disabled={!selection || compositionPending}
                defaultValue={property === 'color' ? '#000000' : '#ffff00'}
                onChange={(event) =>
                  selection && onFormatSelection?.(selection, { [property]: event.target.value })
                }
              />
            </label>
          ))}
          {(['lineSpacing', 'before', 'after', 'indent', 'firstLineIndent'] as const).map(
            (property) => (
              <label key={property}>
                {
                  {
                    lineSpacing: 'Line spacing',
                    before: 'Space before',
                    after: 'Space after',
                    indent: 'Left indent',
                    firstLineIndent: 'First line indent',
                  }[property]
                }{' '}
                <input
                  type="number"
                  aria-label={`Accessible ${property}`}
                  disabled={!activeBlock || compositionPending}
                  min={property === 'firstLineIndent' ? -500 : property === 'lineSpacing' ? 0.5 : 0}
                  max={property === 'lineSpacing' ? 5 : 500}
                  step={property === 'lineSpacing' ? 0.1 : 1}
                  value={activeStyle?.[property] ?? (property === 'lineSpacing' ? 1 : 0)}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (
                      activeBlock &&
                      Number.isFinite(value) &&
                      value >=
                        (property === 'firstLineIndent'
                          ? -500
                          : property === 'lineSpacing'
                            ? 0.5
                            : 0) &&
                      value <= (property === 'lineSpacing' ? 5 : 500)
                    )
                      onFormatParagraph?.(activeBlock, { [property]: value });
                  }}
                />
              </label>
            ),
          )}
          {(['keepWithNext', 'pageBreakBefore'] as const).map((property) => (
            <label key={property}>
              <input
                type="checkbox"
                aria-label={`Accessible ${property}`}
                disabled={!activeBlock || compositionPending}
                checked={activeStyle?.[property] ?? false}
                onChange={(event) =>
                  activeBlock &&
                  onFormatParagraph?.(activeBlock, { [property]: event.target.checked })
                }
              />
              {property === 'keepWithNext' ? 'Keep with next paragraph' : 'Start on new page'}
            </label>
          ))}
        </div>
      )}
      {nodes}
    </article>
  );
}
