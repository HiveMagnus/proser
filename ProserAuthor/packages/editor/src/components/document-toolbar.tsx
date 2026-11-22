'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  DocumentView,
  ParagraphStyle,
  TextStyle,
  DocumentStyleDefinitions,
} from '../document-model';

export interface DocumentToolbarProps {
  disabled: boolean;
  textDisabled: boolean;
  paragraphDisabled: boolean;
  semantic: boolean;
  compositionPending: boolean;
  textStyle: TextStyle & { mixed?: Array<keyof TextStyle> };
  paragraphStyle: ParagraphStyle;
  namedStyles?: DocumentStyleDefinitions;
  onTextFormat: (patch: Partial<TextStyle>) => void;
  onParagraphFormat: (patch: Partial<ParagraphStyle>) => void;
  onNamedStyle: (name: string) => void;
  onCharacterStyle: (name: string) => void;
  onInsertTable: () => void;
  tableInsertion?: 'native' | 'after-paragraph';
  insertingTable?: boolean;
  tracking: boolean;
  trackingDisabled: boolean;
  onTrackingChange: (value: boolean) => void;
  onModeChange: () => void;
  focused: boolean;
  onFocusChange: () => void;
  view: DocumentView;
  onViewChange: (view: DocumentView) => void;
  showReviewControl: boolean;
  showHistoryControls: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  mobile: boolean;
  touchSelection: boolean;
  onTouchSelectionChange: () => void;
  wordCount: number;
}
const icons: Record<string, ReactNode> = {
  Bold: <strong>B</strong>,
  Italic: <em>I</em>,
  Underline: <span style={{ textDecoration: 'underline' }}>U</span>,
  Strikeout: <span style={{ textDecoration: 'line-through' }}>S</span>,
};
export function validFontSize(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const size = Number(value);
  return Number.isFinite(size) && size >= 6 && size <= 144 ? size : undefined;
}
export function colorInputValue(value: string | undefined, fallback: string): string {
  if (value && /^#[\da-f]{6}$/i.test(value)) return value;
  if (value && /^#[\da-f]{3}$/i.test(value))
    return `#${value
      .slice(1)
      .split('')
      .map((digit) => digit + digit)
      .join('')}`;
  return fallback;
}
/** Numeric layout fields retain an input draft until an explicit commit. */
function ParagraphNumberInput({
  label,
  value,
  min,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const committed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);
  const commit = () => {
    if (committed.current === draft) return;
    const next = draft.trim() ? Number(draft) : NaN;
    setEditing(false);
    if (!Number.isFinite(next) || next < min || next > 500) {
      setInvalid(true);
      setDraft(String(value));
      return;
    }
    committed.current = draft;
    setInvalid(false);
    if (next !== value) onCommit(next);
  };
  return (
    <input
      aria-label={label}
      aria-invalid={invalid}
      title={invalid ? `${label} must be between ${min} and 500 px.` : `${label} in pixels`}
      type="number"
      min={min}
      max={500}
      value={draft}
      onFocus={() => {
        committed.current = undefined;
        setEditing(true);
      }}
      onChange={(event) => {
        committed.current = undefined;
        setInvalid(false);
        setEditing(true);
        setDraft(event.target.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          setDraft(String(value));
          setEditing(false);
          setInvalid(false);
        }
      }}
    />
  );
}
/** The same owned controls operate on native Canvas ranges and canonical DOM selections. */
export function DocumentToolbar(props: DocumentToolbarProps) {
  const more = useRef<HTMLDetailsElement>(null);
  const size = props.textStyle.size ?? 16;
  const sizeMixed = props.textStyle.mixed?.includes('size') ?? false;
  const [sizeDraft, setSizeDraft] = useState(sizeMixed ? '' : String(size));
  const [sizeEditing, setSizeEditing] = useState(false);
  const [sizeError, setSizeError] = useState(false);
  const sizeCommit = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!sizeEditing) setSizeDraft(sizeMixed ? '' : String(size));
  }, [size, sizeEditing, sizeMixed]);
  const commitSize = () => {
    if (sizeCommit.current === sizeDraft) return;
    const next = validFontSize(sizeDraft);
    setSizeEditing(false);
    if (next === undefined) {
      if (sizeMixed && !sizeDraft.trim()) return;
      setSizeDraft(sizeMixed ? '' : String(size));
      setSizeError(true);
      return;
    }
    setSizeError(false);
    sizeCommit.current = sizeDraft;
    if (next !== size || sizeMixed) props.onTextFormat({ size: next });
  };
  const textReason = props.disabled
    ? 'Editing is unavailable in this view.'
    : props.semantic && props.textDisabled
      ? 'Select text in the accessible editor to format it.'
      : 'Place the caret in the manuscript or select text.';
  const paragraphReason = props.disabled
    ? 'Editing is unavailable in this view.'
    : 'Place the caret in a paragraph to change its style.';
  const button = (
    label: string,
    content: ReactNode,
    action: () => void,
    active?: boolean | 'mixed',
    disabled = props.textDisabled,
    title = label,
  ) => (
    <button
      type="button"
      aria-label={label}
      title={disabled ? textReason : title}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={action}
      className="proser-toolbar-button"
    >
      {content}
    </button>
  );
  const styleValue = props.paragraphStyle.heading
    ? `heading-${props.paragraphStyle.heading}`
    : (props.paragraphStyle.list ?? 'body');
  return (
    <div className="proser-editor-toolbar">
      <div className="proser-toolbar-row" role="toolbar" aria-label="Document formatting">
        <div className="proser-toolbar-group" role="group" aria-label="Typography">
          <select
            aria-label="Paragraph style"
            title={props.paragraphDisabled ? paragraphReason : 'Paragraph style'}
            className="proser-toolbar-select proser-toolbar-style"
            value={styleValue}
            disabled={props.paragraphDisabled}
            onChange={(event) => {
              const value = event.target.value;
              props.onParagraphFormat({
                name: value.startsWith('heading-') ? `Heading${value.slice(8)}` : 'Normal',
                heading: value.startsWith('heading-')
                  ? (Number(value.slice(8)) as ParagraphStyle['heading'])
                  : undefined,
                list: value === 'bullet' || value === 'number' ? value : undefined,
              });
            }}
          >
            <option value="body">Body</option>
            {[1, 2, 3, 4, 5, 6].map((level) => (
              <option key={level} value={`heading-${level}`}>
                Heading {level}
              </option>
            ))}
            <option value="bullet">Bulleted list</option>
            <option value="number">Numbered list</option>
          </select>
          <select
            aria-label="Font"
            title={props.textDisabled ? textReason : 'Font family'}
            className="proser-toolbar-select proser-toolbar-font"
            value={
              props.textStyle.mixed?.includes('font') ? '' : (props.textStyle.font ?? 'Georgia')
            }
            disabled={props.textDisabled}
            onChange={(event) => props.onTextFormat({ font: event.target.value })}
          >
            {props.textStyle.mixed?.includes('font') && (
              <option value="" disabled>
                Mixed fonts
              </option>
            )}
            {[
              ...new Set([
                props.textStyle.font ?? 'Georgia',
                'Liberation Serif',
                'Liberation Sans',
                'DejaVu Serif',
                'DejaVu Sans',
                'Georgia',
                'Arial',
                'Times New Roman',
                'Courier New',
              ]),
            ].map((font) => (
              <option key={font}>{font}</option>
            ))}
          </select>
          <label className="proser-toolbar-size" title="Font size in pixels (6–144)">
            <input
              aria-label="Font size"
              aria-invalid={sizeError}
              placeholder={sizeMixed ? 'Mixed' : undefined}
              type="number"
              min={6}
              max={144}
              step="0.5"
              value={sizeDraft}
              disabled={props.textDisabled}
              onFocus={() => {
                sizeCommit.current = undefined;
                setSizeEditing(true);
              }}
              onChange={(event) => {
                sizeCommit.current = undefined;
                setSizeEditing(true);
                setSizeError(false);
                setSizeDraft(event.target.value);
              }}
              onBlur={commitSize}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitSize();
                }
                if (event.key === 'Escape') {
                  setSizeDraft(String(size));
                  setSizeError(false);
                  setSizeEditing(false);
                }
              }}
            />
            <span aria-hidden="true">px</span>
          </label>
        </div>
        <div className="proser-toolbar-group" role="group" aria-label="Text formatting">
          {(['bold', 'italic', 'underline', 'strikeout'] as const).map((key) => {
            const label = {
              bold: 'Bold',
              italic: 'Italic',
              underline: 'Underline',
              strikeout: 'Strikeout',
            }[key];
            return (
              <span key={key}>
                {button(
                  label,
                  icons[label],
                  () => props.onTextFormat({ [key]: !props.textStyle[key] }),
                  props.textStyle.mixed?.includes(key) ? 'mixed' : Boolean(props.textStyle[key]),
                )}
              </span>
            );
          })}
          {button(
            'Highlight',
            <svg
              viewBox="0 0 20 20"
              width="18"
              height="18"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="m7 12 6-8 4 3-6 8-4-3ZM7 12l-3 3h5M2 18h16" />
            </svg>,
            () =>
              props.onTextFormat({
                highlight:
                  props.textStyle.highlight || props.textStyle.mixed?.includes('highlight')
                    ? undefined
                    : '#ffff00',
              }),
            props.textStyle.mixed?.includes('highlight')
              ? 'mixed'
              : Boolean(props.textStyle.highlight),
            props.textDisabled,
            props.textStyle.highlight || props.textStyle.mixed?.includes('highlight')
              ? 'Clear highlight'
              : 'Highlight yellow',
          )}
          {(['color', 'highlight'] as const).map((property) => (
            <label
              key={property}
              className="proser-toolbar-color"
              data-mixed={props.textStyle.mixed?.includes(property) || undefined}
              data-empty={
                (property === 'highlight' &&
                  !props.textStyle.highlight &&
                  !props.textStyle.mixed?.includes(property)) ||
                undefined
              }
              title={
                props.textDisabled
                  ? textReason
                  : props.textStyle.mixed?.includes(property)
                    ? `Mixed ${property === 'color' ? 'text colors' : 'highlight colors'}`
                    : property === 'color'
                      ? 'Text color'
                      : props.textStyle.highlight
                        ? 'Highlight color'
                        : 'No highlight · choose color'
              }
            >
              <span aria-hidden="true">{property === 'color' ? 'A' : '▰'}</span>
              <input
                type="color"
                aria-label={property === 'color' ? 'Text color' : 'Highlight color'}
                disabled={props.textDisabled}
                value={colorInputValue(
                  props.textStyle[property],
                  property === 'color' ? '#000000' : '#ffff00',
                )}
                onChange={(event) => props.onTextFormat({ [property]: event.target.value })}
              />
            </label>
          ))}
        </div>
        <div className="proser-toolbar-group" role="group" aria-label="Paragraph alignment">
          {(['left', 'center', 'right', 'justify'] as const).map((alignment) => (
            <button
              key={alignment}
              type="button"
              className="proser-toolbar-button"
              aria-label={`Align ${alignment}`}
              aria-pressed={(props.paragraphStyle.alignment ?? 'left') === alignment}
              title={props.paragraphDisabled ? paragraphReason : `Align ${alignment}`}
              disabled={props.paragraphDisabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => props.onParagraphFormat({ alignment })}
            >
              <svg
                viewBox="0 0 20 20"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                {[4, 8, 12, 16].map((y, index) => {
                  const short = index % 2 === 1 && alignment !== 'justify';
                  const x =
                    alignment === 'right' && short ? 8 : alignment === 'center' && short ? 5 : 2;
                  return <path key={y} d={`M${x} ${y}h${short ? 10 : 16}`} />;
                })}
              </svg>
            </button>
          ))}
        </div>
        <details
          ref={more}
          className="proser-toolbar-details"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              more.current?.removeAttribute('open');
              more.current?.querySelector('summary')?.focus();
              event.stopPropagation();
            }
          }}
        >
          <summary className="proser-toolbar-button" aria-label="More formatting">
            More <span aria-hidden="true">⌄</span>
          </summary>
          <div className="proser-toolbar-panel">
            <div className="proser-toolbar-panel-heading">
              <span>Paragraph</span>
              <button
                type="button"
                aria-label="Close formatting options"
                className="proser-toolbar-panel-close"
                onClick={() => {
                  more.current?.removeAttribute('open');
                  more.current?.querySelector('summary')?.focus();
                }}
              >
                ×
              </button>
            </div>
            <fieldset disabled={props.paragraphDisabled}>
              <label>
                Line spacing
                <select
                  aria-label="Paragraph line spacing"
                  className="proser-toolbar-select"
                  value={props.paragraphStyle.lineSpacing ?? 1}
                  onChange={(event) =>
                    props.onParagraphFormat({ lineSpacing: Number(event.target.value) })
                  }
                >
                  {[
                    ...new Set([props.paragraphStyle.lineSpacing ?? 1, 1, 1.25, 1.5, 2, 2.5, 3]),
                  ].map((spacing) => (
                    <option key={spacing}>{spacing}</option>
                  ))}
                </select>
              </label>
              {(['before', 'after', 'indent', 'firstLineIndent'] as const).map((property) => (
                <label key={property}>
                  {
                    {
                      before: 'Space before',
                      after: 'Space after',
                      indent: 'Left indent',
                      firstLineIndent: 'First line indent',
                    }[property]
                  }{' '}
                  <span className="proser-toolbar-unit">px</span>
                  <ParagraphNumberInput
                    label={
                      {
                        before: 'Space before',
                        after: 'Space after',
                        indent: 'Left indent',
                        firstLineIndent: 'First line indent',
                      }[property]
                    }
                    min={property === 'firstLineIndent' ? -500 : 0}
                    value={props.paragraphStyle[property] ?? 0}
                    onCommit={(value) => props.onParagraphFormat({ [property]: value })}
                  />
                </label>
              ))}
              {(['keepWithNext', 'pageBreakBefore'] as const).map((property) => (
                <label className="proser-toolbar-check" key={property}>
                  <input
                    type="checkbox"
                    aria-label={
                      property === 'keepWithNext'
                        ? 'Keep with next paragraph'
                        : 'Start paragraph on new page'
                    }
                    checked={props.paragraphStyle[property] ?? false}
                    onChange={(event) =>
                      props.onParagraphFormat({ [property]: event.target.checked })
                    }
                  />
                  {property === 'keepWithNext' ? 'Keep with next paragraph' : 'Start on new page'}
                </label>
              ))}
            </fieldset>
            {props.namedStyles && Object.keys(props.namedStyles.paragraph).length > 0 && (
              <label>
                Named style
                <select
                  className="proser-toolbar-select"
                  aria-label="Apply named style"
                  value=""
                  disabled={props.paragraphDisabled}
                  onChange={(event) => props.onNamedStyle(event.target.value)}
                >
                  <option value="">Choose style</option>
                  {Object.keys(props.namedStyles.paragraph).map((name) => (
                    <option key={name} value={name}>
                      {props.namedStyles?.labels?.[name] ?? name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {props.namedStyles && Object.keys(props.namedStyles.text).length > 0 && (
              <label>
                Character style
                <select
                  className="proser-toolbar-select"
                  aria-label="Apply character style"
                  value=""
                  disabled={props.textDisabled}
                  onChange={(event) => props.onCharacterStyle(event.target.value)}
                >
                  <option value="">Choose style</option>
                  {Object.keys(props.namedStyles.text).map((name) => (
                    <option key={name} value={name}>
                      {props.namedStyles?.labels?.[name] ?? name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              type="button"
              className="proser-toolbar-insert"
              aria-label="Insert table"
              disabled={
                props.paragraphDisabled ||
                (props.semantic && props.tableInsertion !== 'after-paragraph') ||
                props.tracking ||
                props.insertingTable
              }
              title={
                props.semantic && props.tableInsertion !== 'after-paragraph'
                  ? 'Use the page editor to insert a table.'
                  : props.tracking
                    ? 'Turn off tracking to insert a table.'
                    : props.paragraphDisabled
                      ? paragraphReason
                      : props.tableInsertion === 'after-paragraph'
                        ? 'Insert a 2 × 2 table after the current paragraph'
                        : 'Insert a 2 × 2 table'
              }
              onMouseDown={(event) => event.preventDefault()}
              onClick={props.onInsertTable}
            >
              {props.insertingTable ? 'Inserting table…' : 'Insert table'}{' '}
              <span aria-hidden="true">2 × 2</span>
            </button>
            <button
              type="button"
              className="proser-toolbar-insert"
              aria-label="Clear highlight"
              disabled={
                props.textDisabled ||
                (!props.textStyle.highlight && !props.textStyle.mixed?.includes('highlight'))
              }
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => props.onTextFormat({ highlight: undefined })}
            >
              Clear highlight
            </button>
          </div>
        </details>
      </div>
      <div className="proser-editor-status">
        {props.showHistoryControls && (
          <div className="proser-toolbar-group" role="group" aria-label="Document history">
            {button(
              'Undo',
              '↶',
              () => props.onUndo?.(),
              undefined,
              props.disabled || !props.canUndo,
              'Undo saved operation',
            )}
            {button(
              'Redo',
              '↷',
              () => props.onRedo?.(),
              undefined,
              props.disabled || !props.canRedo,
              'Redo saved operation',
            )}
          </div>
        )}
        <label className="proser-toolbar-check">
          <input
            type="checkbox"
            aria-label="Track my edits"
            checked={props.tracking}
            disabled={props.trackingDisabled}
            onChange={(event) => props.onTrackingChange(event.target.checked)}
          />
          Track changes
        </label>
        {props.showReviewControl && (
          <select
            className="proser-toolbar-select"
            aria-label="Review view"
            value={props.view}
            disabled={props.compositionPending}
            onChange={(event) => props.onViewChange(event.target.value as DocumentView)}
          >
            <option value="final">Working / final</option>
            <option value="original">Original</option>
            <option value="markup">Markup</option>
          </select>
        )}
        {props.mobile && !props.semantic && (
          <button
            type="button"
            className="proser-toolbar-text-button"
            aria-pressed={props.touchSelection}
            disabled={props.compositionPending}
            onClick={props.onTouchSelectionChange}
          >
            Touch selection
          </button>
        )}
        <button
          type="button"
          className="proser-toolbar-text-button"
          disabled={props.compositionPending}
          onMouseDown={(event) => event.preventDefault()}
          onClick={props.onModeChange}
        >
          {props.semantic ? 'Page editor' : 'Accessible editor'}
        </button>
        <button
          type="button"
          className="proser-toolbar-text-button"
          aria-pressed={props.focused}
          disabled={props.compositionPending}
          onClick={props.onFocusChange}
        >
          {props.focused ? 'Leave focus mode' : 'Focus mode'}
        </button>
        <span className="proser-editor-word-count">{props.wordCount.toLocaleString()} words</span>
      </div>
      {sizeError && (
        <p role="status" className="proser-toolbar-hint">
          Font size must be between 6 and 144 px.
        </p>
      )}
      {props.semantic && props.textDisabled && !props.disabled && (
        <p className="proser-toolbar-hint">
          Select text in a paragraph to format it. Paragraph styles also work at the caret.
        </p>
      )}
    </div>
  );
}
