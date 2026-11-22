export type DocumentNavigationIntent =
  | { kind: 'route'; href: string; method: 'push' | 'replace' }
  | { kind: 'history'; index: number; href: string };
interface Fence {
  dirty: () => boolean;
  blocked: (intent: DocumentNavigationIntent) => void;
}
interface Marker {
  documentId: string;
  index: number;
}
const KEY = '__proserDocumentHistory';
const fences = new Map<symbol, Fence>();
let tracker: { documentId: string; index: number; restoring?: number } | undefined;
function marker(state: unknown): Marker | undefined {
  const value =
    state && typeof state === 'object' ? (state as Record<string, unknown>)[KEY] : undefined;
  if (!value || typeof value !== 'object') return;
  const record = value as Marker;
  return typeof record.documentId === 'string' && Number.isSafeInteger(record.index)
    ? record
    : undefined;
}
const currentFence = () => [...fences.values()].find((fence) => fence.dirty());
/** Track same-document browser positions alongside Next's own untouched state.
 * Capture runs before Next's popstate handler, so blocked traversal cannot mount
 * a different document session before its original history entry is restored. */
export function installDocumentHistoryTracking(): void {
  if (tracker || typeof window === 'undefined') return;
  const saved = marker(window.history.state);
  tracker = { documentId: saved?.documentId ?? crypto.randomUUID(), index: saved?.index ?? 0 };
  const push = window.history.pushState.bind(window.history);
  const replace = window.history.replaceState.bind(window.history);
  const stamp = (data: unknown, index: number) => ({
    ...(data && typeof data === 'object' ? data : {}),
    [KEY]: { documentId: tracker!.documentId, index },
  });
  replace(stamp(window.history.state, tracker.index), '', window.location.href);
  window.history.pushState = (data, title, url) => {
    const index = tracker!.index + 1;
    push(stamp(data, index), title, url);
    tracker!.index = index;
  };
  window.history.replaceState = (data, title, url) =>
    replace(stamp(data, tracker!.index), title, url);
  window.addEventListener(
    'popstate',
    (event) => {
      const target = marker(event.state);
      if (!tracker || !target || target.documentId !== tracker.documentId) return;
      if (tracker.restoring !== undefined) {
        event.stopImmediatePropagation();
        if (target.index === tracker.restoring) {
          tracker.index = target.index;
          tracker.restoring = undefined;
        } else window.history.go(tracker.restoring - target.index);
        return;
      }
      const fence = currentFence();
      if (fence && target.index !== tracker.index) {
        event.stopImmediatePropagation();
        const href = `${window.location.pathname}${window.location.search}${window.location.hash}`;
        fence.blocked({ kind: 'history', index: target.index, href });
        tracker.restoring = tracker.index;
        window.history.go(tracker.index - target.index);
        return;
      }
      tracker.index = target.index;
    },
    true,
  );
}
export function registerDocumentNavigationFence(fence: Fence): () => void {
  installDocumentHistoryTracking();
  const id = Symbol('document-navigation');
  fences.set(id, fence);
  return () => {
    fences.delete(id);
  };
}
export function requestDocumentRoute(href: string, method: 'push' | 'replace'): boolean {
  const fence = currentFence();
  if (!fence) return true;
  const target = new URL(href, window.location.href);
  if (
    target.origin === window.location.origin &&
    target.pathname === window.location.pathname &&
    target.search === window.location.search
  )
    return true;
  fence.blocked({ kind: 'route', href, method });
  return false;
}
export function resumeDocumentHistory(index: number): void {
  if (!tracker || currentFence() || tracker.restoring !== undefined)
    throw new Error('Save or reconcile the current document before traversing its history.');
  window.history.go(index - tracker.index);
}
