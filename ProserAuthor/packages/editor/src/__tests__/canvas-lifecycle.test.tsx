// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanvasDocumentEditor } from '../components/canvas-document-editor';
import { defaultLayout, documentFromText } from '../document-model';
import { paragraphSelection } from '../document-selection';

const native = vi.hoisted(() => ({
  created: vi.fn(),
  destroyed: vi.fn(),
  readSelection: vi.fn(() => ''),
  insertTable: vi.fn(),
  setZone: vi.fn(),
}));
vi.mock('@hivemagnus/canvas-word-engine', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hivemagnus/canvas-word-engine')>();
  return {
    ...original,
    default: class {
      listener = { contentChange: null, rangeStyleChange: null };
      eventBus = { on: vi.fn() };
      command: Record<string, unknown>;
      constructor(_host: HTMLElement, data: unknown, options: unknown) {
        native.created(_host, data, options);
        this.command = {
          executeSetTouchSelectionEnabled: vi.fn(),
          executePageScale: vi.fn(),
          executePaperSize: vi.fn(),
          executeInsertTable: native.insertTable,
          executeSetPositionContext: vi.fn(),
          executeSetZone: native.setZone,
          executeSetRange: vi.fn(),
          executeFocus: vi.fn(),
          getRuntimeElementList: () => (data as { main: unknown[] }).main,
          getRangeContext: () => ({ zone: original.EditorZone.MAIN }),
          getRange: () => ({ startIndex: -1, endIndex: -1 }),
          getRangeText: native.readSelection,
          getValue: () => ({ data }),
          executeSetExternalElementBindings: vi.fn(),
        };
      }
      destroy() {
        native.destroyed();
      }
    },
  };
});

beforeEach(() => {
  native.created.mockClear();
  native.destroyed.mockClear();
  native.readSelection.mockClear();
  native.insertTable.mockClear();
  native.setZone.mockClear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('native Canvas lifecycle', () => {
  it.each([false, true])(
    'fences header/footer pointer input and keeps body typing available with mobile=%s',
    async (mobile) => {
      let identity = 0;
      const document = documentFromText('Owned body', () => `pointer-${++identity}`);
      document.layout.height = 800;
      document.layout.margins = [80, 80, 80, 80];
      const header = documentFromText('Owned header', () => `pointer-${++identity}`);
      const footer = documentFromText('Owned footer', () => `pointer-${++identity}`);
      const host = window.document.createElement('div');
      window.document.body.append(host);
      const root = createRoot(host),
        onError = vi.fn(),
        onChange = vi.fn(),
        bodyPointer = vi.fn();
      try {
        await act(async () =>
          root.render(
            <CanvasDocumentEditor
              document={document}
              mobile={mobile}
              displayStories={{ header, footer }}
              onChange={onChange}
              onError={onError}
            />,
          ),
        );
        expect(native.created.mock.lastCall![2]).toMatchObject({
          margins: mobile ? [24, 16, 24, 16] : [80, 80, 80, 80],
        });
        const surface = host.querySelector('[aria-label="Page editing surface"]')!;
        const canvas = window.document.createElement('canvas');
        const input = window.document.createElement('textarea');
        surface.append(canvas, input);
        canvas.getBoundingClientRect = () => new DOMRect(10, 100, 350, 400);
        canvas.addEventListener('pointerdown', bodyPointer);
        const pointer = async (offset: number) => {
          const event = new MouseEvent('pointerdown', {
            clientY: 100 + offset,
            bubbles: true,
            cancelable: true,
          });
          Object.defineProperty(event, 'pointerType', { value: 'touch' });
          await act(async () => canvas.dispatchEvent(event));
          return event;
        };
        for (const offset of [10, 390]) {
          expect((await pointer(offset)).defaultPrevented).toBe(true);
          expect(onError).toHaveBeenLastCalledWith(
            'Headers and footers are read-only here. Edit their owned stories in Page setup.',
          );
        }
        expect(bodyPointer).not.toHaveBeenCalled();
        const blockedTyping = new InputEvent('beforeinput', {
          inputType: 'insertText',
          data: 'X',
          bubbles: true,
          cancelable: true,
        });
        await act(async () => input.dispatchEvent(blockedTyping));
        expect(blockedTyping.defaultPrevented).toBe(true);
        // Mobile uses its 24px working margin; desktop scales the stored 80px
        // print margin to this canvas. The same physical point differs by mode.
        expect((await pointer(30)).defaultPrevented).toBe(!mobile);
        expect((await pointer(50)).defaultPrevented).toBe(false);
        const bodyTyping = new InputEvent('beforeinput', {
          inputType: 'insertText',
          data: 'X',
          bubbles: true,
          cancelable: true,
        });
        await act(async () => input.dispatchEvent(bodyTyping));
        expect(bodyTyping.defaultPrevented).toBe(false);
        expect(bodyPointer).toHaveBeenCalledTimes(mobile ? 2 : 1);
        // Returning by keyboard has no body pointer event to clear the fence.
        // It must reclaim a verified body selection before permitting input.
        expect((await pointer(10)).defaultPrevented).toBe(true);
        const previousErrors = onError.mock.calls.length;
        await act(async () => (surface as HTMLElement).focus());
        expect(native.setZone).toHaveBeenCalledExactlyOnceWith('main');
        expect(window.document.activeElement).toBe(input);
        const keyboardTyping = new InputEvent('beforeinput', {
          inputType: 'insertText',
          data: 'Y',
          bubbles: true,
          cancelable: true,
        });
        await act(async () => input.dispatchEvent(keyboardTyping));
        expect(keyboardTyping.defaultPrevented).toBe(false);
        expect(onError).toHaveBeenCalledTimes(previousErrors);
        expect(onChange).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
        host.remove();
      }
    },
  );
  it('delegates table insertion with the exact canonical caret and reports rejected structural operations', async () => {
    let identity = 0;
    const document = documentFromText('Owned paragraph', () => `insert-${++identity}`);
    const paragraph = document.blocks[0]!;
    const selection = paragraphSelection(document, paragraph.id, 0, 0, 'Owned paragraph', true)!;
    const host = window.document.createElement('div');
    window.document.body.append(host);
    const root = createRoot(host),
      onInsertTable = vi.fn().mockResolvedValue(undefined),
      onError = vi.fn(),
      onChange = vi.fn();
    try {
      await act(async () =>
        root.render(
          <CanvasDocumentEditor
            document={document}
            initialSelection={selection}
            onChange={onChange}
            onInsertTable={onInsertTable}
            onError={onError}
          />,
        ),
      );
      const insert = host.querySelector<HTMLButtonElement>('[aria-label="Insert table"]')!;
      expect(insert.disabled).toBe(false);
      expect(insert.title).toBe('Insert a 2 × 2 table after the current paragraph');
      await act(async () => {
        host.querySelector<HTMLDetailsElement>('.proser-toolbar-details')!.open = true;
        insert.click();
      });
      expect(onInsertTable).toHaveBeenCalledExactlyOnceWith(selection);
      expect(native.insertTable).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      onInsertTable.mockRejectedValueOnce(
        new Error('This paragraph moved. Reload its saved revision.'),
      );
      await act(async () => insert.click());
      expect(onError).toHaveBeenCalledExactlyOnceWith(
        'This paragraph moved. Reload its saved revision.',
      );
      expect(native.insertTable).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
  it('flushes a retiring passage without recapturing its old selection during navigation', async () => {
    let identity = 0;
    const document = documentFromText(
      'First passage\n\nSecond passage',
      () => `passage-${++identity}`,
    );
    const host = window.document.createElement('div');
    window.document.body.append(host);
    const root = createRoot(host),
      onChange = vi.fn(),
      onError = vi.fn();
    try {
      await act(async () =>
        root.render(
          <CanvasDocumentEditor
            document={document}
            onChange={onChange}
            onError={onError}
            onSelection={vi.fn()}
          />,
        ),
      );
      const navigation = host.querySelector<HTMLSelectElement>('[aria-label="Scene passage"]')!;
      await act(async () => {
        navigation.value = '1';
        navigation.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(native.created).toHaveBeenCalledTimes(2);
      expect(native.destroyed).toHaveBeenCalledTimes(1);
      // The explicit navigation flush can capture the current selection once;
      // lifecycle teardown must never restore it after navigation clears it.
      expect(onError).not.toHaveBeenCalled();
      expect(native.readSelection).toHaveBeenCalledTimes(1);
      expect(onChange).not.toHaveBeenCalled();
      await act(async () => root.unmount());
      expect(native.readSelection).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
  it('keeps input undo local to toolbar/search fields and reserves document undo for manuscript input', async () => {
    let identity = 0;
    const document = documentFromText('Undo target', () => `undo-${++identity}`);
    const host = window.document.createElement('div');
    window.document.body.append(host);
    const root = createRoot(host),
      onUndo = vi.fn();
    try {
      await act(async () =>
        root.render(
          <CanvasDocumentEditor document={document} onChange={vi.fn()} onUndo={onUndo} canUndo />,
        ),
      );
      for (const label of ['Font size', 'Search document', 'Space before']) {
        const input = host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
        const event = new KeyboardEvent('keydown', {
          key: 'z',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        });
        await act(async () => input.dispatchEvent(event));
        expect(event.defaultPrevented).toBe(false);
      }
      expect(onUndo).not.toHaveBeenCalled();
      const input = window.document.createElement('textarea');
      host.querySelector('[aria-label="Page editing surface"]')!.append(input);
      const event = new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      await act(async () => input.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
      expect(onUndo).toHaveBeenCalledOnce();
      const history = new InputEvent('beforeinput', {
        inputType: 'historyUndo',
        bubbles: true,
        cancelable: true,
      });
      await act(async () => input.dispatchEvent(history));
      expect(history.defaultPrevented).toBe(true);
      expect(onUndo).toHaveBeenCalledTimes(2);
      const fieldHistory = new InputEvent('beforeinput', {
        inputType: 'historyUndo',
        bubbles: true,
        cancelable: true,
      });
      await act(async () =>
        host.querySelector('[aria-label="Font size"]')!.dispatchEvent(fieldHistory),
      );
      expect(fieldHistory.defaultPrevented).toBe(false);
      expect(onUndo).toHaveBeenCalledTimes(2);
      expect(host.querySelector<HTMLDetailsElement>('.proser-editor-search')!.open).toBe(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
  it('defers OS document history while semantic IME owns an unfinished composition', async () => {
    let identity = 0;
    const document = documentFromText('Compose here', () => `semantic-ime-${++identity}`);
    const host = window.document.createElement('div');
    window.document.body.append(host);
    const root = createRoot(host),
      onUndo = vi.fn(),
      onRedo = vi.fn(),
      onChange = vi.fn(),
      onCompositionState = vi.fn();
    try {
      await act(async () =>
        root.render(
          <CanvasDocumentEditor
            document={document}
            onChange={onChange}
            onUndo={onUndo}
            onRedo={onRedo}
            onCompositionState={onCompositionState}
            canUndo
            canRedo
          />,
        ),
      );
      await act(async () =>
        Array.from(host.querySelectorAll('button'))
          .find((button) => button.textContent?.trim() === 'Accessible editor')!
          .click(),
      );
      const input = host.querySelector<HTMLTextAreaElement>('[aria-label="Paragraph 1"]')!;
      expect(input).not.toBeNull();
      await act(async () =>
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })),
      );
      expect(onCompositionState).toHaveBeenLastCalledWith(true);
      for (const inputType of ['historyUndo', 'historyRedo']) {
        const event = new InputEvent('beforeinput', {
          inputType,
          bubbles: true,
          cancelable: true,
        });
        await act(async () => input.dispatchEvent(event));
        // IME owns native input history until it commits or cancels preedit.
        expect(event.defaultPrevented).toBe(false);
      }
      expect(onUndo).not.toHaveBeenCalled();
      expect(onRedo).not.toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled();
      await act(async () =>
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })),
      );
      expect(onCompositionState).toHaveBeenLastCalledWith(false);
      for (const inputType of ['historyUndo', 'historyRedo']) {
        const event = new InputEvent('beforeinput', {
          inputType,
          bubbles: true,
          cancelable: true,
        });
        await act(async () => input.dispatchEvent(event));
        expect(event.defaultPrevented).toBe(true);
      }
      expect(onUndo).toHaveBeenCalledOnce();
      expect(onRedo).toHaveBeenCalledOnce();
      expect(input.value).toBe('Compose here');
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
  it('constructs with the new document layout when no display override is supplied', async () => {
    let identity = 0;
    const document = documentFromText('Current layout', () => `layout-${++identity}`);
    const host = window.document.createElement('div');
    window.document.body.append(host);
    const root = createRoot(host);
    const onChange = vi.fn();
    const updated = {
      ...document,
      layout: {
        ...document.layout,
        width: document.layout.width + 50,
        height: document.layout.height + 20,
        margins: [30, 40, 50, 60] as [number, number, number, number],
        font: 'Liberation Sans',
        fontSize: 18,
      },
    };
    try {
      await act(async () =>
        root.render(<CanvasDocumentEditor document={document} onChange={onChange} />),
      );
      await act(async () =>
        root.render(<CanvasDocumentEditor document={updated} onChange={onChange} />),
      );
      expect(native.created).toHaveBeenCalledTimes(2);
      expect(native.created.mock.lastCall![2]).toMatchObject({
        width: updated.layout.width,
        height: updated.layout.height,
        margins: updated.layout.margins,
        defaultFont: updated.layout.font,
        defaultSize: updated.layout.fontSize,
      });
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
  it('retains the instance during equivalent saved echoes and active composition, while applying changed layout/styles/stories', async () => {
    let identity = 0;
    const document = documentFromText('Acknowledged text', () => `id-${++identity}`);
    const header = documentFromText('Owned header', () => `id-${++identity}`);
    const settings = defaultLayout();
    const styles = { text: {}, paragraph: {} };
    const host = window.document.createElement('div');
    window.document.body.append(host);
    const root = createRoot(host);
    const composition = vi.fn();
    const onChange = vi.fn();
    const props = {
      document,
      displayLayout: settings,
      displayStories: { header },
      namedStyles: styles,
      onChange,
      onCompositionState: composition,
    };
    try {
      await act(async () => root.render(<CanvasDocumentEditor {...props} />));
      expect(native.created).toHaveBeenCalledTimes(1);
      const compositionTarget = native.created.mock.lastCall![0] as HTMLElement;
      await act(async () =>
        compositionTarget.dispatchEvent(new Event('compositionstart', { bubbles: true })),
      );
      expect(composition).toHaveBeenLastCalledWith(true);
      await act(async () =>
        root.render(
          <CanvasDocumentEditor
            {...props}
            document={structuredClone(document)}
            displayLayout={structuredClone(settings)}
            displayStories={{ header: structuredClone(header) }}
            namedStyles={structuredClone(styles)}
          />,
        ),
      );
      expect(native.created).toHaveBeenCalledTimes(1);
      expect(native.destroyed).not.toHaveBeenCalled();
      expect(composition).toHaveBeenCalledTimes(1);
      await act(async () => {
        compositionTarget.dispatchEvent(new Event('compositionend', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      expect(composition).toHaveBeenLastCalledWith(false);
      expect(native.created).toHaveBeenCalledTimes(1);

      await act(async () =>
        root.render(
          <CanvasDocumentEditor
            {...props}
            displayLayout={{ ...settings, width: settings.width + 40 }}
          />,
        ),
      );
      expect(native.created).toHaveBeenCalledTimes(2);
      expect(native.destroyed).toHaveBeenCalledTimes(1);
      await act(async () =>
        root.render(
          <CanvasDocumentEditor
            {...props}
            namedStyles={{ text: { Strong: { bold: true } }, paragraph: {} }}
          />,
        ),
      );
      expect(native.created).toHaveBeenCalledTimes(3);
      await act(async () =>
        root.render(
          <CanvasDocumentEditor
            {...props}
            displayStories={{ header: { ...header, blocks: [] } }}
          />,
        ),
      );
      expect(native.created).toHaveBeenCalledTimes(4);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});
