'use client';

import { useSyncExternalStore } from 'react';

/**
 * Desktop writing-view preferences, kept per browser: focus mode hides the
 * app chrome around the manuscript, and typewriter scrolling keeps the line
 * being typed in the middle of the screen.
 */
export interface WritingView {
  focus: boolean;
  typewriter: boolean;
}

const KEY = 'proser-writing-view';
const DEFAULT: WritingView = { focus: false, typewriter: false };
const listeners = new Set<() => void>();
let current: WritingView | null = null;

function read(): WritingView {
  if (current) return current;
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<WritingView> | null;
    current = { focus: stored?.focus === true, typewriter: stored?.typewriter === true };
  } catch {
    current = { ...DEFAULT };
  }
  return current;
}

export function setWritingView(next: Partial<WritingView>): void {
  current = { ...read(), ...next };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* The view still changes for this tab. */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useWritingView(): WritingView {
  return useSyncExternalStore(subscribe, read, () => DEFAULT);
}

/** The element that shows the insertion point: the canvas editor's input or the DOM selection. */
function caretRect(): DOMRect | null {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement && active.classList.contains('ce-inputarea')) {
    const rect = active.getBoundingClientRect();
    if (rect.height || rect.top) return rect;
  }
  const selection = document.getSelection();
  if (selection && selection.rangeCount > 0 && selection.isCollapsed) {
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (rect.height) return rect;
  }
  return null;
}

function scrollParent(element: Element | null): HTMLElement | null {
  for (let node = element?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight)
      return node;
  }
  return document.scrollingElement instanceof HTMLElement ? document.scrollingElement : null;
}

/**
 * Scroll so the insertion point sits in the middle of its scroll area. Small
 * offsets are ignored so the page does not shift on every keystroke.
 */
export function centerCaret(tolerance = 48): boolean {
  const rect = caretRect();
  if (!rect) return false;
  const origin =
    document.activeElement instanceof HTMLTextAreaElement
      ? document.activeElement
      : (document.getSelection()?.anchorNode?.parentElement ?? null);
  const scroller = scrollParent(origin);
  if (!scroller) return false;
  const bounds =
    scroller === document.scrollingElement
      ? { top: 0, height: window.innerHeight }
      : scroller.getBoundingClientRect();
  const offset = rect.top + rect.height / 2 - (bounds.top + bounds.height / 2);
  if (Math.abs(offset) <= tolerance) return false;
  scroller.scrollTop += offset;
  return true;
}
