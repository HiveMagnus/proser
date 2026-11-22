'use client';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import CanvasEditor, {
  EditorMode,
  EditorZone,
  PageMode,
  type IRangeStyle,
  EDITOR_COMPONENT,
  EditorComponent,
  INTERNAL_CONTEXT_MENU_KEY,
} from '@hivemagnus/canvas-word-engine';
import {
  canvasToDocument,
  documentToCanvas,
  canvasTitleOptions,
  headingFontSize,
  ownedCanvasImageSource,
  rebaseCanvasBindings,
  type CanvasDocumentBinding,
} from '../canvas-adapter';
import { trackManualDocumentEdit, editManualParagraphText } from '../manual-review-editing';
import { SemanticDocument } from './semantic-document';
import { DocumentToolbar } from './document-toolbar';
import {
  refreshFormattingSelection,
  selectionTextStyle,
  type SelectionTextStyle,
} from '../selection-formatting';
import {
  canvasDocumentWindow,
  mergeCanvasDocumentWindow,
  acknowledgeCanvasWindow,
  refreshCanvasDocumentWindow,
  canvasParagraphContinuation,
  windowSelection,
  canvasWindowForSelection,
  type CanvasDocumentWindow,
} from '../canvas-window';
import { formatDocumentSelection, formatDocumentParagraph } from '../semantic-operations';
import {
  canvasSelection,
  paragraphSelection,
  restoreCanvasSelection,
  type DocumentSelection,
} from '../document-selection';
import {
  canonicalDocument,
  projectDocument,
  resolveChange,
  type ProserDocument,
  type DocumentView,
  type DocumentLayout,
  type DocumentStyleDefinitions,
  type DocumentParagraph,
  type ParagraphStyle,
  type TextStyle,
  paragraphGroups,
  effectiveParagraphStyle,
  visibleRun,
} from '../document-model';

export interface CanvasDocumentEditorProps {
  document: ProserDocument;
  editable?: boolean;
  tracking?: boolean;
  onTrackingChange?: (tracking: boolean) => void;
  view?: DocumentView;
  onViewChange?: (view: DocumentView) => void;
  initialSelection?: DocumentSelection;
  actorId?: number;
  displayLayout?: DocumentLayout;
  displayStories?: { header?: ProserDocument; footer?: ProserDocument };
  namedStyles?: DocumentStyleDefinitions;
  mobile?: boolean;
  onChange: (document: ProserDocument) => void;
  onResolveChange?: (id: string, status: 'accepted' | 'rejected') => Promise<void>;
  canResolveChange?: (id: string) => boolean;
  /** Owned structural insertion for workspaces with bounded document windows. */
  onInsertTable?: (selection: DocumentSelection) => Promise<void> | void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  showHistoryControls?: boolean;
  showReviewControl?: boolean;
  onCompositionState?: (pending: boolean) => void;
  onError?: (message: string) => void;
  onRejectedEdit?: (nativeValue: unknown, message: string) => void;
  discardRejectedToken?: number;
  onSelection?: (text: string) => void;
  onDocumentSelection?: (selection: DocumentSelection | undefined, error?: string) => void;
}
/** Owned controls and semantic mode. Canvas commands never persist content directly. */
export function CanvasDocumentEditor({
  document,
  editable = true,
  tracking: controlledTracking,
  onTrackingChange,
  view: controlledView,
  onViewChange,
  initialSelection,
  actorId,
  displayLayout,
  displayStories,
  namedStyles,
  mobile = false,
  onChange,
  onResolveChange,
  canResolveChange,
  onInsertTable,
  onError,
  onRejectedEdit,
  discardRejectedToken = 0,
  onSelection,
  onDocumentSelection,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
  showHistoryControls = true,
  showReviewControl = true,
  onCompositionState,
}: CanvasDocumentEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const surface = useRef<HTMLElement>(null);
  const inputHelpId = useId();
  const inputContextId = useId();
  const changeLabelId = useId();
  const editor = useRef<CanvasEditor | null>(null);
  const state = useRef(document);
  const callback = useRef({ onChange, onError, onRejectedEdit, onSelection, onDocumentSelection });
  callback.current = { onChange, onError, onRejectedEdit, onSelection, onDocumentSelection };
  const emitted = useRef('');
  // React can deliver older controlled echoes after a newer native input.
  // They acknowledge emitted objects, never replace the newer live document.
  const localEchoes = useRef(new WeakSet<ProserDocument>());
  const [resolving, setResolving] = useState(false);
  const [insertingTable, setInsertingTable] = useState(false);
  const [localTracking, setLocalTracking] = useState(false);
  const manualTracking = controlledTracking ?? localTracking;
  const setManualTracking = (value: boolean) =>
    onTrackingChange ? onTrackingChange(value) : setLocalTracking(value);
  const tracking = useRef(false);
  tracking.current = manualTracking;
  const [initialWindow] = useState(() => {
    try {
      return initialSelection ? canvasWindowForSelection(document, initialSelection) : undefined;
    } catch {
      return undefined;
    }
  });
  const [semantic, setSemantic] = useState(Boolean(initialSelection && !initialWindow));
  const frozenFocus = useRef<DocumentSelection | undefined>(initialSelection);
  const [semanticFocus, setSemanticFocus] = useState<DocumentSelection | undefined>(
    initialSelection,
  );
  const [localView, setLocalView] = useState<DocumentView>('final');
  const view = controlledView ?? localView;
  const setView = (value: DocumentView) =>
    onViewChange ? onViewChange(value) : setLocalView(value);
  const [rangeStyle, setRangeStyle] = useState<IRangeStyle | null>(null);
  const [, updateSelectionControls] = useState(0);
  const refreshControls = () => updateSelectionControls((version) => version + 1);
  const [search, setSearch] = useState('');
  const [passageStart, setPassageStart] = useState(() =>
    Math.max(
      0,
      document.blocks.findIndex(
        (block) =>
          block.id ===
          (initialSelection?.container.tableId ?? initialSelection?.targets[0]?.blockId),
      ),
    ),
  );
  const [passagePart, setPassagePart] = useState(() => initialWindow?.part ?? 0);
  const appliedFocus = useRef<string | undefined>(undefined);
  const paperWidth = useRef<number | undefined>(undefined);
  const passage = useRef<CanvasDocumentWindow | undefined>(undefined);
  const [touchSelection, setTouchSelection] = useState(false);
  const [focused, setFocused] = useState(false);
  const [compositionPending, setCompositionPending] = useState(false);
  const composing = useRef(false);
  const storyFocusBlocked = useRef(false);
  const settingNativeValue = useRef(false);
  const effectiveLayout = displayLayout ?? document.layout;
  // Saved passages arrive as fresh objects. Only a changed presentation may
  // rebuild Canvas: an equivalent acknowledgement must retain native input,
  // selection and an in-progress IME composition.
  const presentationKey = canonicalDocument({
    layout: effectiveLayout,
    header: displayStories?.header,
    footer: displayStories?.footer,
    namedStyles,
  });
  const renderData = (value: ProserDocument) => {
    const layout = effectiveLayout;
    const workingLayout =
      mobile && paperWidth.current
        ? {
            ...layout,
            width: paperWidth.current,
            margins: [24, 16, 24, 16] as [number, number, number, number],
          }
        : layout;
    const data = documentToCanvas(
      { ...value, layout: workingLayout },
      view,
      namedStyles,
      canvasParagraphContinuation(passage.current),
    );
    if (displayStories?.header)
      data.header = documentToCanvas(
        { ...displayStories.header, layout: workingLayout },
        view,
        namedStyles,
      ).main;
    if (displayStories?.footer)
      data.footer = documentToCanvas(
        { ...displayStories.footer, layout: workingLayout },
        view,
        namedStyles,
      ).main;
    return data;
  };
  const captureNativeSelection = (instance: CanvasEditor) => {
    if (settingNativeValue.current) return;
    callback.current.onSelection?.(instance.command.getRangeText());
    if (view !== 'final') {
      callback.current.onDocumentSelection?.(undefined);
      return;
    }
    try {
      const active = passage.current!;
      frozenFocus.current = windowSelection(
        active,
        canvasSelection(instance.command, active.document, true),
        state.current,
      );
      refreshControls();
      callback.current.onDocumentSelection?.(
        windowSelection(active, canvasSelection(instance.command, active.document), state.current),
      );
    } catch (error) {
      frozenFocus.current = undefined;
      refreshControls();
      callback.current.onDocumentSelection?.(
        undefined,
        error instanceof Error ? error.message : 'Unable to map this selection.',
      );
    }
  };
  const setNativeValue = (instance: CanvasEditor, value: ReturnType<typeof renderData>) => {
    settingNativeValue.current = true;
    try {
      instance.command.executeSetValue(value);
    } finally {
      settingNativeValue.current = false;
    }
  };
  const publish = (captureSelection = true) => {
    if (
      !editor.current ||
      !editable ||
      view !== 'final' ||
      composing.current ||
      settingNativeValue.current
    )
      return;
    let nativeValue: unknown;
    try {
      const zone = editor.current.command.getRangeContext()?.zone;
      if (storyFocusBlocked.current || (zone !== undefined && zone !== EditorZone.MAIN)) {
        storyFocusBlocked.current = false;
        editor.current.command.executeSetZone(EditorZone.MAIN);
        if (passage.current) setNativeValue(editor.current, renderData(passage.current.document));
        callback.current.onError?.(
          'Headers and footers are read-only here. Edit their owned stories in Page setup.',
        );
        return;
      }
      const serialized = editor.current.command.getValue({ extraPickAttrs: ['id'] });
      nativeValue = serialized;
      const active = passage.current;
      if (!active) return;
      const previous = active.document;
      const bindings: CanvasDocumentBinding[] = [];
      const edited = canvasToDocument(
        { ...serialized.data, header: undefined, footer: undefined },
        previous,
        () => crypto.randomUUID(),
        undefined,
        bindings,
        tracking.current,
        actorId,
      );
      const tracked =
        tracking.current && actorId
          ? trackManualDocumentEdit(previous, edited, actorId, () => crypto.randomUUID())
          : edited;
      const next = mergeCanvasDocumentWindow(state.current, active, tracked);
      editor.current.command.executeSetExternalElementBindings(
        tracked === edited ? bindings : rebaseCanvasBindings(bindings, tracked),
      );
      acknowledgeCanvasWindow(active, next, tracked);
      const hash = canonicalDocument(next);
      const changed = hash !== canonicalDocument(state.current);
      state.current = next;
      // Native formatting renders range events before the adapter rebases run
      // bindings. Recompute the exact live range against the acknowledged data.
      if (captureSelection) captureNativeSelection(editor.current);
      if (!changed) return;
      emitted.current = hash;
      localEchoes.current.add(next);
      callback.current.onChange(next);
    } catch (error) {
      callback.current.onRejectedEdit?.(
        nativeValue,
        error instanceof Error
          ? error.message
          : 'This edit cannot be saved as a supported document.',
      );
      callback.current.onError?.(
        error instanceof Error ? error.message : 'Unable to serialize the document.',
      );
    }
  };
  useLayoutEffect(() => {
    if (!host.current || semantic) return;
    const layout = effectiveLayout;
    const innerWidth = () => {
      if (!host.current) return layout.width;
      const style = getComputedStyle(host.current);
      return Math.max(
        240,
        host.current.clientWidth -
          parseFloat(style.paddingLeft || '0') -
          parseFloat(style.paddingRight || '0'),
      );
    };
    const active = canvasDocumentWindow(state.current, passageStart, 2400, passagePart);
    passage.current = active;
    paperWidth.current = mobile ? innerWidth() : layout.width;
    const instance = new CanvasEditor(host.current, renderData(active.document), {
      mode: editable && view === 'final' ? EditorMode.EDIT : EditorMode.READONLY,
      pageMode: mobile ? PageMode.CONTINUITY : PageMode.PAGING,
      width: mobile ? innerWidth() : layout.width,
      height: layout.height,
      margins: mobile ? [24, 16, 24, 16] : layout.margins,
      defaultFont: layout.font,
      defaultSize: layout.fontSize,
      minSize: 6,
      maxSize: 144,
      title: canvasTitleOptions(layout.fontSize),
      historyMaxRecordCount: 0,
      imageSourceAllowed: ownedCanvasImageSource,
      contextMenuDisableKeys: [
        INTERNAL_CONTEXT_MENU_KEY.TABLE.MERGE_CELL,
        INTERNAL_CONTEXT_MENU_KEY.TABLE.CANCEL_MERGE_CELL,
        INTERNAL_CONTEXT_MENU_KEY.IMAGE.CHANGE,
        INTERNAL_CONTEXT_MENU_KEY.IMAGE.SAVE_AS,
        INTERNAL_CONTEXT_MENU_KEY.IMAGE.TEXT_WRAP,
      ],
      pageNumber: { disabled: !layout.pageNumbers },
      header: {
        editable: false,
        disabled: !(displayStories?.header?.blocks.length || layout.header.length),
      },
      footer: {
        editable: false,
        disabled: !(displayStories?.footer?.blocks.length || layout.footer.length),
      },
      locale: 'en',
    });
    editor.current = instance;
    const input = host.current.querySelector('textarea');
    if (input) {
      input.setAttribute('aria-label', 'Canvas writing input');
      input.setAttribute('aria-describedby', `${inputHelpId} ${inputContextId}`);
      input.readOnly = !editable || view !== 'final';
      input.tabIndex = -1;
    }
    instance.command.executeSetTouchSelectionEnabled(touchSelection);
    emitted.current = canonicalDocument(state.current);
    instance.listener.contentChange = publish;
    instance.listener.rangeStyleChange = setRangeStyle;
    instance.eventBus.on('rangeChange', () => captureNativeSelection(instance));
    const resize = () => {
      const width = innerWidth();
      if (mobile) {
        if (composing.current) return;
        if (paperWidth.current !== width) {
          publish();
          paperWidth.current = width;
          setNativeValue(instance, renderData(passage.current!.document));
          if (frozenFocus.current)
            try {
              restoreCanvasSelection(
                instance.command,
                passage.current!.document,
                windowSelection(passage.current!, frozenFocus.current, state.current, true)!,
              );
            } catch {
              frozenFocus.current = undefined;
            }
        }
        instance.command.executePaperSize(Math.max(240, width), layout.height);
        instance.command.executePageScale(1);
      } else instance.command.executePageScale(Math.min(1, width / layout.width));
    };
    const node = host.current;
    const visible = () => {
      const viewport = window.visualViewport;
      if (surface.current) {
        surface.current.style.setProperty(
          '--proser-viewport-height',
          `${viewport?.height ?? window.innerHeight}px`,
        );
        surface.current.style.setProperty(
          '--proser-keyboard-inset',
          `${Math.max(0, window.innerHeight - (viewport?.height ?? window.innerHeight) - (viewport?.offsetTop ?? 0))}px`,
        );
      }
      if (globalThis.document.activeElement === input && !composing.current)
        instance.command.executeFocus({ range: instance.command.getRange() });
    };
    let compositionEndTimer: ReturnType<typeof setTimeout> | undefined;
    const compositionStart = () => {
      composing.current = true;
      setCompositionPending(true);
      onCompositionState?.(true);
    };
    const compositionEnd = () => {
      clearTimeout(compositionEndTimer);
      compositionEndTimer = setTimeout(() => {
        if (editor.current !== instance) return;
        composing.current = false;
        publish();
        resize();
        visible();
        setCompositionPending(false);
        onCompositionState?.(false);
      }, 1);
    };
    node.addEventListener('compositionstart', compositionStart);
    node.addEventListener('compositionend', compositionEnd);
    window.visualViewport?.addEventListener('resize', visible);
    window.visualViewport?.addEventListener('scroll', visible);
    visible();
    const observer = new ResizeObserver(resize);
    observer.observe(host.current);
    resize();
    if (search) instance.command.executeSearch(search);
    if (view === 'final' && frozenFocus.current) {
      try {
        restoreCanvasSelection(
          instance.command,
          active.document,
          windowSelection(active, frozenFocus.current, state.current, true)!,
        );
      } catch (error) {
        callback.current.onError?.(
          error instanceof Error ? error.message : 'Unable to restore this selection.',
        );
        frozenFocus.current = undefined;
      }
    }
    return () => {
      // Navigation has already cleared or frozen the intended next selection.
      // Flush content without reviving a caret from the retiring native window.
      publish(false);
      observer.disconnect();
      node.removeEventListener('compositionstart', compositionStart);
      node.removeEventListener('compositionend', compositionEnd);
      window.visualViewport?.removeEventListener('resize', visible);
      window.visualViewport?.removeEventListener('scroll', visible);
      clearTimeout(compositionEndTimer);
      instance.listener.contentChange = null;
      instance.listener.rangeStyleChange = null;
      instance.destroy();
      editor.current = null;
    };
    // Construction depends on view/mode; the document is synchronized separately.
  }, [
    semantic,
    mobile,
    editable,
    view,
    passageStart,
    passagePart,
    presentationKey,
    inputHelpId,
    inputContextId,
  ]);
  useEffect(() => {
    const node = surface.current;
    if (!node) return;
    const historyInput = (event: InputEvent) => {
      const target = event.target;
      if (
        storyFocusBlocked.current &&
        target instanceof Element &&
        target.closest('[aria-label="Page editing surface"]')
      ) {
        event.preventDefault();
        event.stopPropagation();
        callback.current.onError?.(
          'Headers and footers are read-only here. Edit their owned stories in Page setup.',
        );
        return;
      }
      if (!['historyUndo', 'historyRedo'].includes(event.inputType)) return;
      if (
        !(target instanceof Element) ||
        !target.closest(
          '[aria-label="Page editing surface"], [aria-label="Semantic manuscript"]',
        ) ||
        !editable ||
        view !== 'final' ||
        composing.current ||
        compositionPending ||
        event.isComposing
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (event.inputType === 'historyUndo' && canUndo) onUndo?.();
      if (event.inputType === 'historyRedo' && canRedo) onRedo?.();
    };
    node.addEventListener('beforeinput', historyInput, true);
    return () => node.removeEventListener('beforeinput', historyInput, true);
  }, [editable, view, compositionPending, canUndo, canRedo, onUndo, onRedo]);
  useEffect(() => {
    if (localEchoes.current.has(document)) return;
    const hash = canonicalDocument(document);
    if (hash === emitted.current) {
      state.current = document;
      return;
    }
    const before = state.current;
    state.current = document;
    const previousWindow =
      passage.current ?? canvasDocumentWindow(before, passageStart, 2400, passagePart);
    const prior = previousWindow.document;
    const active = refreshCanvasDocumentWindow(document, previousWindow);
    passage.current = active;
    const visible = active.document;
    if (canonicalDocument(renderData(prior)) !== canonicalDocument(renderData(visible))) {
      if (editor.current) setNativeValue(editor.current, renderData(visible));
      if (editor.current && frozenFocus.current && view === 'final') {
        try {
          restoreCanvasSelection(
            editor.current.command,
            visible,
            windowSelection(active, frozenFocus.current, document, true)!,
          );
        } catch {
          frozenFocus.current = undefined;
        }
      }
    }
    emitted.current = hash;
    refreshControls();
  }, [document, view]);
  useLayoutEffect(() => {
    if (!initialSelection) return;
    const key = canonicalDocument(initialSelection);
    if (appliedFocus.current === key) return;
    frozenFocus.current = initialSelection;
    if (semantic) {
      setSemanticFocus(initialSelection);
      appliedFocus.current = key;
      return;
    }
    const index = state.current.blocks.findIndex(
      (block) =>
        block.id === (initialSelection.container.tableId ?? initialSelection.targets[0]?.blockId),
    );
    if (index < 0) {
      callback.current.onError?.('This selected block is no longer in the document.');
      return;
    }
    const active = passage.current;
    let selectedWindow: CanvasDocumentWindow;
    try {
      selectedWindow = canvasWindowForSelection(state.current, initialSelection);
    } catch {
      setSemanticFocus(initialSelection);
      setSemantic(true);
      return;
    }
    if (
      !active ||
      index < active.start ||
      index >= active.end ||
      selectedWindow.part !== active.part
    ) {
      setPassageStart(index);
      setPassagePart(selectedWindow.part);
      return;
    }
    try {
      if (editor.current)
        restoreCanvasSelection(
          editor.current.command,
          active.document,
          windowSelection(active, initialSelection, state.current, true)!,
        );
      appliedFocus.current = key;
    } catch (reason) {
      callback.current.onError?.(
        reason instanceof Error ? reason.message : 'The selection is stale.',
      );
    }
  }, [initialSelection, semantic, passageStart, passagePart]);
  const rejectedDiscard = useRef(discardRejectedToken);
  useLayoutEffect(() => {
    if (rejectedDiscard.current === discardRejectedToken) return;
    rejectedDiscard.current = discardRejectedToken;
    frozenFocus.current = undefined;
    const active = canvasDocumentWindow(state.current, passageStart, 2400, passagePart);
    passage.current = active;
    if (editor.current) setNativeValue(editor.current, renderData(active.document));
  }, [discardRejectedToken, passageStart, passagePart]);
  const changePassage = (start: number, part = 0) => {
    publish();
    frozenFocus.current = undefined;
    setPassageStart(start);
    setPassagePart(part);
  };
  const findPassage = (query: string, next = false) => {
    if (!query) {
      editor.current?.command.executeSearch(null);
      return;
    }
    const blocks = state.current.blocks;
    const first = next ? (passage.current?.end ?? 0) : 0;
    const indices = Array.from(
      { length: blocks.length },
      (_, offset) => (first + offset) % blocks.length,
    );
    const index = indices.find((index) =>
      projectDocument({ ...state.current, blocks: [blocks[index]!] }, view)
        .text.toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
    );
    if (index === undefined) return;
    if (index >= (passage.current?.start ?? 0) && index < (passage.current?.end ?? 0))
      editor.current?.command.executeSearch(query);
    else changePassage(index);
  };
  const command = (action: (instance: CanvasEditor) => void) => {
    if (!editor.current || !editable || view !== 'final' || composing.current || compositionPending)
      return;
    try {
      const instance = editor.current;
      if (frozenFocus.current && passage.current)
        restoreCanvasSelection(
          instance.command,
          passage.current.document,
          windowSelection(passage.current, frozenFocus.current, state.current, true)!,
        );
      action(instance);
      publish();
      instance.command.executeFocus({ range: instance.command.getRange() });
    } catch (error) {
      onError?.(
        error instanceof Error
          ? error.message
          : 'This formatting could not be applied. Select the text again.',
      );
    }
  };
  const emitCanonicalFormat = (formatted: ProserDocument) => {
    const next =
      tracking.current && actorId
        ? trackManualDocumentEdit(state.current, formatted, actorId, () => crypto.randomUUID())
        : formatted;
    frozenFocus.current = refreshFormattingSelection(next, frozenFocus.current);
    state.current = next;
    refreshControls();
    onChange(next);
  };
  const formatTextPatch = (patch: Partial<TextStyle>) => {
    if (!editable || view !== 'final' || compositionPending) return;
    if (semantic) {
      try {
        if (!frozenFocus.current?.runs.length)
          throw new Error('Select text in the accessible editor to format it.');
        emitCanonicalFormat(
          formatDocumentSelection(
            state.current,
            frozenFocus.current,
            patch,
            () => crypto.randomUUID(),
            actorId,
          ),
        );
      } catch (error) {
        onError?.(error instanceof Error ? error.message : 'Unable to format this selection.');
      }
      return;
    }
    command((instance) => {
      if ('font' in patch && patch.font) instance.command.executeFont(patch.font);
      if ('size' in patch && patch.size !== undefined) instance.command.executeSize(patch.size);
      if ('bold' in patch) instance.command.executeBold();
      if ('italic' in patch) instance.command.executeItalic();
      if ('underline' in patch) instance.command.executeUnderline();
      if ('strikeout' in patch) instance.command.executeStrikeout();
      if ('color' in patch && patch.color) instance.command.executeColor(patch.color);
      if ('highlight' in patch) instance.command.executeHighlight(patch.highlight ?? null);
    });
  };
  const editParagraph = (blockId: string, text: string) => {
    try {
      onChange(
        editManualParagraphText(state.current, blockId, text, actorId, tracking.current, () =>
          crypto.randomUUID(),
        ),
      );
      return true;
    } catch (error) {
      onError?.(error instanceof Error ? error.message : 'Unable to edit this paragraph.');
      return false;
    }
  };
  const logicalParagraph = (blockId: string): DocumentParagraph | undefined => {
    let contiguous: DocumentParagraph[] = [];
    for (const block of state.current.blocks) {
      if (block.type === 'paragraph') contiguous.push(block);
      else {
        const group = paragraphGroups(contiguous, state.current.changes, 'final').find((group) =>
          group.some((paragraph) => paragraph.id === blockId),
        );
        if (group) return group[0];
        contiguous = [];
        if (block.type === 'table')
          for (const row of block.rows)
            for (const cell of row.cells) {
              const group = paragraphGroups(cell.paragraphs, state.current.changes, 'final').find(
                (group) => group.some((paragraph) => paragraph.id === blockId),
              );
              if (group) return group[0];
            }
      }
    }
    return paragraphGroups(contiguous, state.current.changes, 'final').find((group) =>
      group.some((paragraph) => paragraph.id === blockId),
    )?.[0];
  };
  const formatParagraphPatch = (patch: Partial<ParagraphStyle>) => {
    try {
      if (!editable || view !== 'final' || compositionPending) return;
      const paragraphs = new Set(
        frozenFocus.current?.targets
          .map((target) => logicalParagraph(target.blockId)?.id)
          .filter((id): id is string => Boolean(id)),
      );
      if (!paragraphs.size)
        throw new Error('Place the caret in the paragraph before changing its layout.');
      let formatted = state.current;
      for (const id of paragraphs)
        formatted = formatDocumentParagraph(formatted, id, patch, actorId);
      emitCanonicalFormat(formatted);
    } catch (reason) {
      onError?.(reason instanceof Error ? reason.message : 'Paragraph layout could not apply.');
    }
  };
  const activeLayoutParagraph =
    frozenFocus.current?.targets[0] && logicalParagraph(frozenFocus.current.targets[0].blockId);
  const activeParagraphStyle = activeLayoutParagraph
    ? effectiveParagraphStyle(activeLayoutParagraph, state.current, 'final', namedStyles)
    : undefined;
  const applyNamedStyle = (name: string) => {
    try {
      const selection = frozenFocus.current;
      if (!selection?.targets.length || !namedStyles?.paragraph[name])
        throw new Error('Place the caret in a paragraph before applying its named style.');
      let next = state.current;
      for (const blockId of new Set(selection.targets.map((target) => target.blockId))) {
        next = formatDocumentParagraph(next, blockId, { name }, actorId);
      }
      emitCanonicalFormat(next);
    } catch (reason) {
      onError?.(reason instanceof Error ? reason.message : 'Named style could not apply.');
    }
  };
  const applyCharacterStyle = (styleId: string) => {
    try {
      const selection = frozenFocus.current;
      if (!selection?.runs.length || !namedStyles?.text[styleId])
        throw new Error('Select text before applying its character style.');
      const next = formatDocumentSelection(
        state.current,
        selection,
        { characterStyleId: styleId },
        () => crypto.randomUUID(),
        actorId,
      );
      emitCanonicalFormat(next);
    } catch (reason) {
      onError?.(reason instanceof Error ? reason.message : 'Character style could not apply.');
    }
  };
  const resolveReview = async (changeId: string, status: 'accepted' | 'rejected') => {
    if (resolving || composing.current || !(canResolveChange?.(changeId) ?? editable)) return;
    setResolving(true);
    try {
      if (onResolveChange) await onResolveChange(changeId, status);
      else onChange(resolveChange(state.current, changeId, status));
    } catch (reason) {
      onError?.(
        reason instanceof Error
          ? reason.message
          : 'Review resolution failed. Save or recover this revision first.',
      );
    } finally {
      setResolving(false);
    }
  };
  const editingDisabled = !editable || view !== 'final' || compositionPending;
  const semanticStyle = selectionTextStyle(state.current, frozenFocus.current, namedStyles);
  const toolbarTextStyle: SelectionTextStyle = semantic
    ? {
        font: effectiveLayout.font,
        size: activeParagraphStyle?.heading
          ? headingFontSize(activeParagraphStyle.heading, effectiveLayout.fontSize)
          : effectiveLayout.fontSize,
        ...semanticStyle,
      }
    : {
        font: rangeStyle?.font ?? effectiveLayout.font,
        size: rangeStyle?.size ?? effectiveLayout.fontSize,
        bold: rangeStyle?.bold,
        italic: rangeStyle?.italic,
        underline: rangeStyle?.underline,
        strikeout: rangeStyle?.strikeout,
        color: rangeStyle?.color ?? undefined,
        highlight: rangeStyle?.highlight ?? undefined,
        mixed: semanticStyle.mixed,
      };
  const insertTable = async () => {
    if (editingDisabled || manualTracking || insertingTable) return;
    if (!onInsertTable) {
      if (!semantic) command((instance) => instance.command.executeInsertTable(2, 2));
      return;
    }
    setInsertingTable(true);
    try {
      const selection = refreshFormattingSelection(state.current, frozenFocus.current);
      if (!selection?.targets.length)
        throw new Error('Place the caret in a paragraph before inserting a table.');
      await onInsertTable(structuredClone(selection));
    } catch (error) {
      onError?.(error instanceof Error ? error.message : 'The table could not be inserted.');
    } finally {
      setInsertingTable(false);
    }
  };
  const changeEditorMode = () => {
    if (!semantic && editor.current && view === 'final') {
      publish();
      try {
        frozenFocus.current = windowSelection(
          passage.current!,
          canvasSelection(editor.current.command, passage.current!.document, true),
          state.current,
        );
      } catch (error) {
        onError?.(error instanceof Error ? error.message : 'Unable to preserve this selection.');
        return;
      }
      setSemanticFocus(frozenFocus.current);
    } else if (frozenFocus.current?.targets[0]) {
      const index = state.current.blocks.findIndex(
        (block) =>
          block.id === frozenFocus.current!.targets[0]!.blockId ||
          (block.type === 'table' && block.id === frozenFocus.current!.container.tableId),
      );
      if (index >= 0) {
        try {
          const selected = canvasWindowForSelection(state.current, frozenFocus.current!);
          setPassageStart(index);
          setPassagePart(selected.part);
        } catch (reason) {
          onError?.(
            reason instanceof Error
              ? reason.message
              : 'Select a range within one text slice before switching.',
          );
          return;
        }
      }
    }
    setSemantic(!semantic);
  };
  const focusPageInput = () => {
    const instance = editor.current,
      active = passage.current;
    if (!instance || !active || !editable || view !== 'final' || composing.current) return;
    try {
      const zone = instance.command.getRangeContext()?.zone;
      const reclaimBody =
        storyFocusBlocked.current || (zone !== undefined && zone !== EditorZone.MAIN);
      if (reclaimBody) instance.command.executeSetZone(EditorZone.MAIN);
      if (reclaimBody && frozenFocus.current) {
        const target = windowSelection(active, frozenFocus.current, state.current, true);
        if (!target) throw new Error('Select a body paragraph before returning to the page input.');
        restoreCanvasSelection(instance.command, active.document, target);
      } else if (reclaimBody || instance.command.getRange().startIndex < 0) {
        const first = active.document.blocks.flatMap((block) =>
          block.type === 'paragraph'
            ? [block]
            : block.type === 'table'
              ? block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.paragraphs))
              : [],
        )[0];
        if (!first) throw new Error('Choose a text paragraph before using the page input.');
        const value = first.runs
          .filter((run) => visibleRun(run, active.document.changes, 'final'))
          .map((run) => (run.inlineImage ? '\ufffc' : run.text))
          .join('');
        const target = paragraphSelection(active.document, first.id, 0, 0, value, true)!;
        restoreCanvasSelection(instance.command, active.document, target);
        frozenFocus.current = windowSelection(active, target, state.current);
        refreshControls();
      }
      storyFocusBlocked.current = false;
      instance.command.executeFocus({ range: instance.command.getRange() });
      // Keyboard entry must reach the real input synchronously. The engine's
      // deferred cursor render must not consume the user's next Tab or key.
      host.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
    } catch (error) {
      onError?.(error instanceof Error ? error.message : 'Unable to focus this paragraph.');
    }
  };
  const describedParagraph = state.current.blocks
    .flatMap((block) =>
      block.type === 'paragraph'
        ? [block]
        : block.type === 'table'
          ? block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.paragraphs))
          : [],
    )
    .find((paragraph) => paragraph.id === frozenFocus.current?.targets[0]?.blockId);
  return (
    <section
      ref={surface}
      role="region"
      aria-label="Manuscript document"
      onKeyDownCapture={(event) => {
        if (
          storyFocusBlocked.current &&
          (event.target as HTMLElement).closest?.('[aria-label="Page editing surface"]') &&
          !['Tab', 'Escape'].includes(event.key)
        ) {
          event.preventDefault();
          event.stopPropagation();
          callback.current.onError?.(
            'Headers and footers are read-only here. Edit their owned stories in Page setup.',
          );
          return;
        }
        const target = event.target as HTMLElement;
        // The maintained engine uses Tab for document indentation. Proser's
        // page input must also have a predictable keyboard exit, in either
        // direction, without inserting content or losing its saved selection.
        if (
          event.key === 'Tab' &&
          target instanceof HTMLTextAreaElement &&
          target.closest('[aria-label="Page editing surface"]') &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !event.nativeEvent.isComposing &&
          !composing.current
        ) {
          const candidates = Array.from(
            target.ownerDocument.querySelectorAll<HTMLElement>(
              'button, input, select, textarea, a[href], summary, [tabindex]',
            ),
          ).filter(
            (node) =>
              node.tabIndex >= 0 &&
              !node.matches(':disabled') &&
              !node.closest('[inert]') &&
              !host.current?.contains(node) &&
              node !== host.current &&
              (!node.checkVisibility || node.checkVisibility()) &&
              Array.from(target.ownerDocument.querySelectorAll('details:not([open])')).every(
                (details) =>
                  !details.contains(node) ||
                  details.querySelector(':scope > summary')?.contains(node),
              ) &&
              node.getClientRects().length > 0,
          );
          const direction = event.shiftKey
            ? Node.DOCUMENT_POSITION_PRECEDING
            : Node.DOCUMENT_POSITION_FOLLOWING;
          const ordered = event.shiftKey ? candidates.reverse() : candidates;
          event.preventDefault();
          event.stopPropagation();
          for (const destination of ordered) {
            if (!(target.compareDocumentPosition(destination) & direction)) continue;
            destination.focus();
            if (target.ownerDocument.activeElement === destination) break;
          }
          return;
        }
        const manuscriptInput =
          target.closest?.('[aria-label="Page editing surface"]') ||
          (target instanceof HTMLTextAreaElement &&
            target.closest('[aria-label="Semantic manuscript"]'));
        if (
          !manuscriptInput ||
          !editable ||
          compositionPending ||
          view !== 'final' ||
          !(event.ctrlKey || event.metaKey) ||
          event.altKey ||
          event.nativeEvent.isComposing
        )
          return;
        const key = event.key.toLowerCase();
        if (key === 'z' || key === 'y') {
          event.preventDefault();
          event.stopPropagation();
          if ((key === 'y' || event.shiftKey) && canRedo) onRedo?.();
          else if (key === 'z' && !event.shiftKey && canUndo) onUndo?.();
        }
      }}
      className={focused ? 'proser-editor proser-editor--focus' : 'proser-editor'}
    >
      <div {...{ [EDITOR_COMPONENT]: EditorComponent.MENU }}>
        <DocumentToolbar
          disabled={editingDisabled}
          textDisabled={
            editingDisabled || (semantic ? !frozenFocus.current?.runs.length : !frozenFocus.current)
          }
          paragraphDisabled={editingDisabled || !activeLayoutParagraph}
          semantic={semantic}
          compositionPending={compositionPending}
          textStyle={toolbarTextStyle}
          paragraphStyle={activeParagraphStyle ?? {}}
          namedStyles={namedStyles}
          onTextFormat={formatTextPatch}
          onParagraphFormat={formatParagraphPatch}
          onNamedStyle={applyNamedStyle}
          onCharacterStyle={applyCharacterStyle}
          onInsertTable={() => void insertTable()}
          tableInsertion={onInsertTable ? 'after-paragraph' : 'native'}
          insertingTable={insertingTable}
          tracking={manualTracking}
          trackingDisabled={!actorId || editingDisabled}
          onTrackingChange={setManualTracking}
          showHistoryControls={showHistoryControls}
          showReviewControl={showReviewControl}
          canUndo={canUndo}
          canRedo={canRedo}
          onUndo={onUndo}
          onRedo={onRedo}
          view={view}
          onViewChange={setView}
          onModeChange={changeEditorMode}
          focused={focused}
          onFocusChange={() => setFocused(!focused)}
          mobile={mobile}
          touchSelection={touchSelection}
          onTouchSelectionChange={() => {
            const enabled = !touchSelection;
            setTouchSelection(enabled);
            editor.current?.command.executeSetTouchSelectionEnabled(enabled);
          }}
          wordCount={projectDocument(document, view).wordCount}
        />
      </div>
      {!semantic && (
        <details className="proser-editor-search">
          <summary>Find in text</summary>
          <div role="search">
            <label className="min-w-0 flex-1 text-sm">
              Find in this scene
              <input
                aria-label="Search document"
                placeholder="Search saved or unsaved text"
                className="mt-1 block min-h-11 w-full rounded border border-border-muted bg-surface-base px-3"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  findPassage(event.target.value);
                }}
              />
            </label>
            <button
              type="button"
              className="min-h-11 rounded border border-border-muted px-3"
              onClick={() => {
                const command = editor.current?.command;
                const navigation = command?.getSearchNavigateInfo();
                if (navigation && navigation.index < navigation.count - 1)
                  command?.executeSearchNavigateNext();
                else findPassage(search, true);
              }}
            >
              Next match
            </button>
          </div>
        </details>
      )}
      {semantic && displayStories?.header && (
        <aside aria-label="Header story">
          <SemanticDocument
            document={displayStories.header}
            view={view}
            namedStyles={namedStyles}
          />
        </aside>
      )}
      {semantic ? (
        <SemanticDocument
          document={displayLayout ? { ...document, layout: displayLayout } : document}
          view={view}
          namedStyles={namedStyles}
          editable={editable && view === 'final'}
          showFormattingControls={false}
          onEditParagraph={editParagraph}
          onCompositionState={(pending) => {
            setCompositionPending(pending);
            onCompositionState?.(pending);
          }}
          onSelection={(selection, error) => {
            if (error) frozenFocus.current = undefined;
            else if (selection) frozenFocus.current = selection;
            refreshControls();
            onDocumentSelection?.(selection, error);
          }}
          initialSelection={semanticFocus}
          onFocusSelection={(selection) => {
            frozenFocus.current = selection;
            refreshControls();
          }}
          onFormatSelection={(selection, patch) => {
            try {
              const formatted = formatDocumentSelection(
                state.current,
                selection,
                patch,
                () => crypto.randomUUID(),
                actorId,
              );
              onChange(
                tracking.current && actorId
                  ? trackManualDocumentEdit(state.current, formatted, actorId, () =>
                      crypto.randomUUID(),
                    )
                  : formatted,
              );
            } catch (error) {
              onError?.(
                error instanceof Error ? error.message : 'Unable to format this selection.',
              );
            }
          }}
          onFormatParagraph={(blockId, patch) => {
            try {
              const formatted = formatDocumentParagraph(state.current, blockId, patch, actorId);
              onChange(
                tracking.current && actorId
                  ? trackManualDocumentEdit(state.current, formatted, actorId, () =>
                      crypto.randomUUID(),
                    )
                  : formatted,
              );
            } catch (error) {
              onError?.(
                error instanceof Error ? error.message : 'Unable to format this paragraph.',
              );
            }
          }}
        />
      ) : (
        <div>
          <p id={inputHelpId} className="sr-only">
            Type in the page input. Tab and Shift+Tab move to the surrounding controls. Use
            Accessible editor for structured heading, list and table editing, or expand Read this
            passage to browse the same saved and unsaved text.
          </p>
          <p id={inputContextId} className="sr-only">
            {describedParagraph
              ? `Current paragraph: ${describedParagraph.runs
                  .filter((run) => visibleRun(run, state.current.changes, view))
                  .map((run) => (run.inlineImage ? `Image: ${run.inlineImage.alt}` : run.text))
                  .join('')}`
              : 'Place the caret in a paragraph to edit.'}
          </p>
          <div
            ref={host}
            role="region"
            tabIndex={editable && view === 'final' ? 0 : -1}
            aria-describedby={inputHelpId}
            onFocus={(event) => {
              if (event.target === event.currentTarget) focusPageInput();
            }}
            onPointerDownCapture={(event) => {
              const canvas = event.target instanceof HTMLCanvasElement ? event.target : undefined;
              if (!canvas) return;
              const rectangle = canvas.getBoundingClientRect(),
                layout = displayLayout ?? state.current.layout;
              const height = mobile ? rectangle.height : layout.height;
              const y = ((event.clientY - rectangle.top) * height) / rectangle.height;
              const header = Boolean(displayStories?.header?.blocks.length || layout.header.length),
                footer = Boolean(displayStories?.footer?.blocks.length || layout.footer.length);
              const margins = mobile ? [24, 16, 24, 16] : layout.margins;
              if ((header && y < margins[0]!) || (footer && y > height - margins[2]!)) {
                storyFocusBlocked.current = true;
                event.preventDefault();
                event.stopPropagation();
                callback.current.onError?.(
                  'Headers and footers are read-only here. Edit their owned stories in Page setup.',
                );
              } else storyFocusBlocked.current = false;
            }}
            className="proser-editor-paper"
            aria-label="Page editing surface"
          />
          <details className="proser-canvas-text-preview">
            <summary>Read this passage</summary>
            <SemanticDocument document={document} view={view} namedStyles={namedStyles} />
          </details>
          <nav aria-label="Scene passages" className="proser-editor-passages">
            <button
              type="button"
              disabled={(passageStart === 0 && passagePart === 0) || compositionPending}
              onClick={() =>
                passagePart > 0
                  ? changePassage(passageStart, passagePart - 1)
                  : changePassage(
                      Math.max(0, passageStart - 1),
                      canvasDocumentWindow(state.current, Math.max(0, passageStart - 1)).parts - 1,
                    )
              }
            >
              Previous passage
            </button>
            <label>
              Scene passage{' '}
              <select
                aria-label="Scene passage"
                value={Math.min(passageStart, Math.max(0, document.blocks.length - 1))}
                disabled={compositionPending}
                onChange={(event) => changePassage(Number(event.target.value))}
              >
                {document.blocks.map((block, index) => (
                  <option key={block.id} value={index}>
                    {block.type === 'paragraph'
                      ? 'Paragraph'
                      : block.type === 'table'
                        ? 'Table'
                        : block.type === 'image'
                          ? 'Image'
                          : 'Page break'}{' '}
                    {index + 1}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={
                ((passage.current?.end ?? 0) >= document.blocks.length &&
                  passagePart + 1 >= (passage.current?.parts ?? 1)) ||
                compositionPending
              }
              onClick={() =>
                passagePart + 1 < (passage.current?.parts ?? 1)
                  ? changePassage(passageStart, passagePart + 1)
                  : changePassage(passage.current?.end ?? 0)
              }
            >
              Next passage
            </button>
          </nav>
          {(passage.current?.parts ?? 1) > 1 && (
            <p role="status">
              Passage {passagePart + 1} of {passage.current?.parts}. Use the accessible editor for
              whole-paragraph and table edits.
            </p>
          )}
        </div>
      )}
      {!!document.changes.filter((change) => change.status === 'pending').length && (
        <aside aria-label="Tracked changes" className="space-y-2 border-t border-border-muted p-3">
          {document.changes
            .filter((change) => change.status === 'pending')
            .map((change) => (
              <div key={change.id} className="flex flex-wrap items-center gap-3">
                <span id={`${changeLabelId}-${change.id}`}>
                  {change.authorName}: {change.kind}
                </span>
                <button
                  type="button"
                  aria-describedby={`${changeLabelId}-${change.id}`}
                  disabled={
                    !(canResolveChange?.(change.id) ?? editable) || resolving || compositionPending
                  }
                  onClick={() => void resolveReview(change.id, 'accepted')}
                >
                  Accept change
                </button>
                <button
                  type="button"
                  aria-describedby={`${changeLabelId}-${change.id}`}
                  disabled={
                    !(canResolveChange?.(change.id) ?? editable) || resolving || compositionPending
                  }
                  onClick={() => void resolveReview(change.id, 'rejected')}
                >
                  Reject change
                </button>
              </div>
            ))}
        </aside>
      )}
      {semantic && displayStories?.footer && (
        <aside aria-label="Footer story">
          <SemanticDocument
            document={displayStories.footer}
            view={view}
            namedStyles={namedStyles}
          />
        </aside>
      )}
    </section>
  );
}
