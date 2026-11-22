import Editor, {
  EditorMode,
  PageMode,
  TitleLevel,
  ListType,
  ListStyle,
  type IElement,
} from '@hivemagnus/canvas-word-engine';
const host = document.getElementById('native-core') as HTMLDivElement;
let editor: Editor;
let touchPointerId: number | undefined;
host.addEventListener('pointerdown', (event) => {
  if (event.pointerType === 'touch') touchPointerId = event.pointerId;
});
let initial: ReturnType<Editor['command']['getValue']>;
const text = (elements: IElement[]): string =>
  elements.map((element) => (element.valueList ? text(element.valueList) : element.value)).join('');
function mount(value = 'A😀e\u0301Z', table = false) {
  editor?.destroy();
  host.innerHTML = '';
  touchPointerId = undefined;
  document.body.style.minHeight = '';
  const paragraph = {
    value,
    font: 'Liberation Serif',
    size: 18,
    bold: true,
    extension: { fixture: 'native-owned-run' },
  };
  const main: IElement[] = table
    ? [
        {
          type: 'table' as IElement['type'],
          value: '',
          id: 'owned-table',
          colgroup: [{ width: 140 }, { width: 140 }],
          trList: [
            {
              id: 'owned-row',
              height: 50,
              tdList: [
                { id: 'owned-cell', colspan: 1, rowspan: 1, value: [paragraph] },
                {
                  id: 'protected-cell',
                  colspan: 1,
                  rowspan: 1,
                  value: [{ value: 'Untouched cell', italic: true }],
                },
              ],
            },
          ],
        },
      ]
    : [paragraph];
  editor = new Editor(
    host,
    {
      main,
      header: [{ value: 'Unchanged header', italic: true }],
      footer: [{ value: 'Unchanged footer' }],
    },
    {
      width: 350,
      height: 500,
      margins: [40, 30, 40, 30],
      defaultFont: 'Liberation Serif',
      defaultSize: 18,
      locale: 'en',
      header: { disabled: true },
      footer: { disabled: true },
    },
  );
  initial = editor.command.getValue({ extraPickAttrs: ['id'] });
}
function select(query: string, caret = false) {
  const range = editor.command.getKeywordRangeList(query)[0];
  if (!range) throw new Error('Missing native fixture target: ' + query);
  editor.command.executeSetPositionContext(range);
  editor.command.executeSetRange(caret ? range.endIndex : range.startIndex, range.endIndex);
  editor.command.executeFocus({ range: editor.command.getRange() });
  return editor.command.getRangeContext()!.rangeRects[0];
}
function agent() {
  return host.querySelector<HTMLTextAreaElement>('.ce-inputarea')!;
}
function snapshot() {
  const saved = editor.command.getValue({ extraPickAttrs: ['id'] });
  const target = saved.data.main[0]!;
  return {
    body: target.trList ? text(target.trList[0]!.tdList[0]!.value) : text(saved.data.main),
    data: saved.data,
    original: initial.data,
    range: editor.command.getRange(),
    focused: document.activeElement === agent(),
    captured:
      touchPointerId !== undefined &&
      host.querySelector('canvas')!.hasPointerCapture(touchPointerId),
  };
}
function intent(inputType: string, composing = false, cancelable = true, outsideFence = false) {
  const before = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable,
    inputType,
    data: null,
    isComposing: composing,
  });
  if (outsideFence) before.preventDefault();
  agent().dispatchEvent(before);
  if (!before.defaultPrevented)
    agent().dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType, data: null, isComposing: composing }),
    );
  return before.defaultPrevented;
}
function touchPoints() {
  select('Two');
  const from = editor.command.getRangeContext()!.rangeRects[0]!;
  select('Four');
  const to = editor.command.getRangeContext()!.rangeRects[0]!;
  select('Two');
  const bounds = host.querySelector('canvas')!.getBoundingClientRect();
  return {
    from: { x: bounds.x + from.x + from.width / 2, y: bounds.y + from.y + from.height / 2 },
    to: { x: bounds.x + to.x + to.width, y: bounds.y + to.y + to.height / 2 },
  };
}
function visibleViewport() {
  editor?.destroy();
  host.innerHTML = '';
  document.body.style.minHeight = '5000px';
  const descriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport')!;
  const viewport = Object.assign(new EventTarget(), {
    offsetLeft: 0,
    offsetTop: 0,
    width: innerWidth,
    height: 300,
    scale: 1,
  });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  editor = new Editor(
    host,
    {
      main: [
        { value: Array.from({ length: 45 }, (_, index) => 'line' + index).join('\n') + '\nTARGET' },
      ],
    },
    {
      pageMode: PageMode.CONTINUITY,
      width: 350,
      height: 1600,
      margins: [40, 30, 40, 30],
      header: { disabled: true },
      footer: { disabled: true },
    },
  );
  select('TARGET', true);
  return () => Object.defineProperty(window, 'visualViewport', descriptor);
}
async function deferredFocus(mode: 'normal' | 'redirect' | 'destroy') {
  mount('Focus target');
  const requestedFrom = document.createElement('button');
  const redirectedTo = document.createElement('button');
  document.body.append(requestedFrom, redirectedTo);
  requestedFrom.focus();
  const target = agent();
  let attempts = 0;
  const focus = target.focus.bind(target);
  target.focus = (options) => {
    attempts++;
    focus(options);
  };
  const range = editor.command.getKeywordRangeList('target')[0]!;
  editor.command.executeSetPositionContext(range);
  editor.command.executeSetRange(range.endIndex, range.endIndex);
  if (mode !== 'normal') redirectedTo.focus();
  if (mode === 'destroy') editor.destroy();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const result = {
    attempts,
    connected: target.isConnected,
    agentFocused: document.activeElement === target,
    externalFocused: document.activeElement === redirectedTo,
  };
  requestedFrom.remove();
  redirectedTo.remove();
  return result;
}
let restoreViewport: (() => void) | undefined;
Object.assign(window, {
  nativeMobile: {
    mount,
    select,
    snapshot,
    intent,
    touchPoints,
    deferredFocus,
    focus: () => editor.command.executeFocus({ range: editor.command.getRange() }),
    paragraphStyle: (kind: 'heading' | 'list') =>
      kind === 'heading'
        ? editor.command.executeTitle(TitleLevel.FIRST)
        : editor.command.executeList(ListType.UL, ListStyle.DISC),
    readonly: () => editor.command.executeMode(EditorMode.READONLY),
    undo: () => editor.command.executeUndo(),
    redo: () => editor.command.executeRedo(),
    touch: (enabled: boolean) => editor.command.executeSetTouchSelectionEnabled(enabled),
    releasePointer: () => {
      if (touchPointerId !== undefined)
        host.querySelector('canvas')!.releasePointerCapture(touchPointerId);
    },
    blur: () => editor.command.executeBlur(),
    composition: (type: 'compositionstart' | 'compositionend', data = '') =>
      agent().dispatchEvent(new CompositionEvent(type, { bubbles: true, data })),
    insert: (data: string) =>
      agent().dispatchEvent(
        new InputEvent('input', { bubbles: true, data, inputType: 'insertText' }),
      ),
    viewport: () => {
      restoreViewport = visibleViewport();
    },
    viewportResult: () => {
      const cursor = host.querySelector<HTMLElement>('.ce-cursor')!.getBoundingClientRect();
      return {
        top: cursor.top,
        bottom: cursor.bottom,
        visibleHeight: visualViewport!.height,
        layoutHeight: innerHeight,
        scrollY,
        range: editor.command.getRange(),
      };
    },
    reset: () => {
      restoreViewport?.();
      restoreViewport = undefined;
      editor?.destroy();
      host.innerHTML = '';
      document.body.style.minHeight = '';
    },
  },
});
