// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DocumentToolbar,
  validFontSize,
  colorInputValue,
  type DocumentToolbarProps,
} from '../components/document-toolbar';

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());
const props = (): DocumentToolbarProps => ({
  disabled: false,
  textDisabled: false,
  paragraphDisabled: false,
  semantic: false,
  compositionPending: false,
  textStyle: { font: 'Georgia', size: 16, bold: true, color: '#345678', highlight: '#fedcba' },
  paragraphStyle: {},
  onTextFormat: vi.fn(),
  onParagraphFormat: vi.fn(),
  onNamedStyle: vi.fn(),
  onCharacterStyle: vi.fn(),
  onInsertTable: vi.fn(),
  tracking: false,
  trackingDisabled: false,
  onTrackingChange: vi.fn(),
  onModeChange: vi.fn(),
  focused: false,
  onFocusChange: vi.fn(),
  view: 'final',
  onViewChange: vi.fn(),
  showReviewControl: false,
  showHistoryControls: false,
  canUndo: false,
  canRedo: false,
  mobile: false,
  touchSelection: false,
  onTouchSelectionChange: vi.fn(),
  wordCount: 250,
});
async function renderToolbar(options: DocumentToolbarProps) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<DocumentToolbar {...options} />));
  return {
    host,
    cleanup: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}
async function inputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
describe('owned formatting toolbar', () => {
  it('validates font sizes without treating empty input as zero', () => {
    expect(validFontSize('')).toBeUndefined();
    expect(validFontSize('  ')).toBeUndefined();
    expect(validFontSize('5')).toBeUndefined();
    expect(validFontSize('145')).toBeUndefined();
    expect(validFontSize('NaN')).toBeUndefined();
    expect(validFontSize('18')).toBe(18);
    expect(validFontSize('144')).toBe(144);
    expect(colorInputValue('#abc', '#000000')).toBe('#aabbcc');
  });
  it('keeps size changes as a draft until Enter, supports 144 px, and refuses invalid input', async () => {
    const options = props(),
      { host, cleanup } = await renderToolbar(options);
    try {
      const input = host.querySelector<HTMLInputElement>('[aria-label="Font size"]')!;
      await act(async () => input.focus());
      await inputValue(input, '1');
      expect(input.value).toBe('1');
      expect(options.onTextFormat).not.toHaveBeenCalled();
      await inputValue(input, '18');
      // Canvas restores its input focus as the command executes. The resulting
      // blur must acknowledge the same Enter edit instead of applying it twice.
      vi.mocked(options.onTextFormat).mockImplementationOnce(() => input.blur());
      await act(async () =>
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
      );
      expect(options.onTextFormat).toHaveBeenCalledExactlyOnceWith({ size: 18 });
      await inputValue(input, '144');
      await act(async () =>
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
      );
      expect(options.onTextFormat).toHaveBeenLastCalledWith({ size: 144 });
      await inputValue(input, '');
      await act(async () =>
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
      );
      expect(options.onTextFormat).toHaveBeenCalledTimes(2);
      expect(input.value).toBe('16');
      expect(host.querySelector('[role="status"]')?.textContent).toContain('6 and 144');
    } finally {
      await cleanup();
    }
  });
  it('commits paragraph spacing after the full numeric draft and rejects empty edits', async () => {
    const options = props(),
      { host, cleanup } = await renderToolbar(options);
    try {
      const input = host.querySelector<HTMLInputElement>('[aria-label="Space before"]')!;
      await act(async () => {
        host.querySelector('details')!.open = true;
        input.focus();
      });
      await inputValue(input, '1');
      expect(options.onParagraphFormat).not.toHaveBeenCalled();
      await inputValue(input, '18');
      vi.mocked(options.onParagraphFormat).mockImplementationOnce(() => input.blur());
      await act(async () =>
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
      );
      expect(options.onParagraphFormat).toHaveBeenCalledExactlyOnceWith({ before: 18 });
      await inputValue(input, '');
      await act(async () =>
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
      );
      expect(options.onParagraphFormat).toHaveBeenCalledTimes(1);
      expect(input.value).toBe('0');
      expect(input.getAttribute('aria-invalid')).toBe('true');
    } finally {
      await cleanup();
    }
  });
  it('reflects selected formatting and uses one shared semantic toolbar', async () => {
    const options = { ...props(), semantic: true },
      { host, cleanup } = await renderToolbar(options);
    try {
      const bold = host.querySelector<HTMLButtonElement>('[aria-label="Bold"]')!;
      expect(bold.getAttribute('aria-pressed')).toBe('true');
      await act(async () => bold.click());
      expect(options.onTextFormat).toHaveBeenCalledWith({ bold: false });
      expect(host.querySelector<HTMLInputElement>('[aria-label="Text color"]')?.value).toBe(
        '#345678',
      );
      expect(host.querySelector<HTMLInputElement>('[aria-label="Highlight color"]')?.value).toBe(
        '#fedcba',
      );
      expect(host.querySelector('[aria-label="Undo"]')).toBeNull();
      expect(host.querySelector('[aria-label="Review view"]')).toBeNull();
      expect(host.querySelector('details')?.open).toBe(false);
      const more = host.querySelector('details')!;
      more.open = true;
      await act(async () =>
        host.querySelector<HTMLButtonElement>('[aria-label="Close formatting options"]')!.click(),
      );
      expect(more.open).toBe(false);
      expect(document.activeElement).toBe(more.querySelector('summary'));
      more.open = true;
      await act(async () =>
        more.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      expect(more.open).toBe(false);
      const style = host.querySelector<HTMLSelectElement>('[aria-label="Paragraph style"]')!;
      await act(async () => {
        style.value = 'heading-2';
        style.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(options.onParagraphFormat).toHaveBeenCalledWith({
        name: 'Heading2',
        heading: 2,
        list: undefined,
      });
      expect(host.querySelector<HTMLButtonElement>('[aria-label="Insert table"]')?.disabled).toBe(
        true,
      );
    } finally {
      await cleanup();
    }
  });
  it.each([
    { highlight: undefined, mixed: undefined, active: 'false', patch: '#ffff00' },
    { highlight: '#ffff00', mixed: undefined, active: 'true', patch: undefined },
    { highlight: undefined, mixed: ['highlight'] as const, active: 'mixed', patch: undefined },
  ])(
    'explicitly toggles highlighting from $active without requiring a color-input change event',
    async ({ highlight, mixed, active, patch }) => {
      const options = props();
      options.textStyle = {
        ...options.textStyle,
        highlight,
        mixed: mixed ? [...mixed] : undefined,
      };
      const { host, cleanup } = await renderToolbar(options);
      try {
        const toggle = host.querySelector<HTMLButtonElement>('[aria-label="Highlight"]')!;
        expect(toggle.getAttribute('aria-pressed')).toBe(active);
        await act(async () => toggle.click());
        expect(options.onTextFormat).toHaveBeenCalledExactlyOnceWith({ highlight: patch });
      } finally {
        await cleanup();
      }
    },
  );
  it('distinguishes absent highlight from yellow and allows clearing mixed highlights', async () => {
    const options = props();
    options.textStyle = { ...options.textStyle, highlight: undefined };
    const { host, cleanup } = await renderToolbar(options);
    try {
      const color = host
        .querySelector<HTMLInputElement>('[aria-label="Highlight color"]')!
        .closest('label')!;
      expect(color.getAttribute('data-empty')).toBe('true');
      expect(color.title).toBe('No highlight · choose color');
      expect(
        host.querySelector<HTMLButtonElement>('[aria-label="Clear highlight"]')!.disabled,
      ).toBe(true);
    } finally {
      await cleanup();
    }
    options.textStyle = { ...options.textStyle, mixed: ['highlight'] };
    const mixed = await renderToolbar(options);
    try {
      const clear = mixed.host.querySelector<HTMLButtonElement>('[aria-label="Clear highlight"]')!;
      expect(clear.disabled).toBe(false);
      await act(async () => clear.click());
      expect(options.onTextFormat).toHaveBeenCalledWith({ highlight: undefined });
    } finally {
      await mixed.cleanup();
    }
  });
  it('disables formatting and mode switches during composition', async () => {
    const options = {
        ...props(),
        disabled: true,
        textDisabled: true,
        paragraphDisabled: true,
        compositionPending: true,
      },
      { host, cleanup } = await renderToolbar(options);
    try {
      for (const label of [
        'Bold',
        'Italic',
        'Underline',
        'Strikeout',
        'Align left',
        'Insert table',
      ])
        expect(host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.disabled).toBe(
          true,
        );
      for (const label of ['Font', 'Font size', 'Paragraph style', 'Text color'])
        expect(
          (host.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement)
            .disabled,
        ).toBe(true);
      expect(
        Array.from(host.querySelectorAll('button')).find(
          (button) => button.textContent === 'Accessible editor',
        )?.disabled,
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
