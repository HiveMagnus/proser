import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { documentFromText } from '@hivemagnus/proser-contracts';
import type { PassageTypedSnapshot } from '@/lib/document-passage-typed-session';
const records = vi.hoisted(() => {
  class FakeSession {
    snapshot: PassageTypedSnapshot = { state: 'saved', canUndo: false, canRedo: false };
    listeners = new Set<() => void>();
    activate = vi.fn();
    load = vi.fn(async () => undefined);
    dispose = vi.fn();
    retainDraft = vi.fn(async () => undefined);
    save = vi.fn(async () => undefined);
    flush = vi.fn(async () => undefined);
    constructor(public identity: { userId: string; bookId: string; sceneId: string }) {
      records.sessions.push(this);
    }
    getSnapshot = () => this.snapshot;
    subscribe = (listener: () => void) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    };
    state(state: PassageTypedSnapshot['state']) {
      this.snapshot = { ...this.snapshot, state };
      this.listeners.forEach((listener) => listener());
    }
    dirty() {
      this.snapshot = {
        ...this.snapshot,
        state: 'unsaved',
        document: documentFromText('Retained owned input', () => crypto.randomUUID()),
      };
      this.listeners.forEach((listener) => listener());
    }
  }
  return { sessions: [] as FakeSession[], FakeSession };
});
vi.mock('@/lib/document-passage-typed-session', () => ({
  PassageTypedSession: records.FakeSession,
}));
vi.mock('@/lib/document-passage-api', () => ({
  getScenePassage: vi.fn(),
  commitScenePassageOperations: vi.fn(),
  restoreScenePassage: vi.fn(),
  recoverScenePassage: vi.fn(),
}));
vi.mock('@/lib/document-passage-journal', () => ({
  readDocumentPassageDraft: vi.fn(),
  writeDocumentPassageDraft: vi.fn(),
  acknowledgeDocumentPassageDraft: vi.fn(),
  deleteDocumentPassageDraft: vi.fn(),
}));
import { useDocumentPassageSession } from '@/hooks/use-document-passage-session';
const transition = (type: 'pageshow' | 'pagehide', persisted: boolean) => {
  const event = new Event(type);
  Object.defineProperty(event, 'persisted', { value: persisted });
  window.dispatchEvent(event);
};
beforeEach(() => {
  vi.useFakeTimers();
  records.sessions.length = 0;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('active passage browser lifecycle fences', () => {
  it('retains background work locally and removes all lifecycle listeners on unmount', async () => {
    const hook = renderHook(() => useDocumentPassageSession('owner', '1', '4'));
    const session = records.sessions[0]!;
    act(() => session.state('unsaved'));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    act(() => transition('pagehide', true));
    expect(session.retainDraft).toHaveBeenCalledTimes(2);
    expect(session.save).not.toHaveBeenCalled();
    hook.unmount();
    act(() => {
      transition('pagehide', true);
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(session.retainDraft).toHaveBeenCalledTimes(2);
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });
  it.each(['unsaved', 'saving', 'conflict', 'recoverable', 'failed'] as const)(
    'protects %s state before reload without dispatching an uncertain save',
    (state) => {
      renderHook(() => useDocumentPassageSession('owner', '1', '4'));
      const session = records.sessions[0]!;
      act(() => session.state(state));
      const event = new Event('beforeunload', { cancelable: true });
      act(() => window.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
      expect(session.retainDraft).toHaveBeenCalledTimes(1);
      expect(session.save).not.toHaveBeenCalled();
    },
  );
  it('protects an active composition even when the acknowledged canonical state is Saved', () => {
    renderHook(() => useDocumentPassageSession('owner', '1', '4', { composing: true }));
    const session = records.sessions[0]!;
    const event = new Event('beforeunload', { cancelable: true });
    act(() => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    expect(session.retainDraft).toHaveBeenCalledTimes(1);
    expect(session.save).not.toHaveBeenCalled();
    act(() => transition('pageshow', true));
    expect(session.load).toHaveBeenCalledTimes(1);
  });
  it('rechecks only a clean saved passage on bfcache return and preserves recoverable work', () => {
    renderHook(() => useDocumentPassageSession('owner', '1', '4'));
    const session = records.sessions[0]!;
    act(() => transition('pageshow', false));
    expect(session.load).toHaveBeenCalledTimes(1);
    act(() => transition('pageshow', true));
    expect(session.load).toHaveBeenCalledTimes(2);
    act(() => session.state('recoverable'));
    act(() => transition('pageshow', true));
    expect(session.load).toHaveBeenCalledTimes(2);
    expect(session.save).not.toHaveBeenCalled();
  });
  it('keeps composition and offline fences while retaining the ordinary autosave deadline', async () => {
    const hook = renderHook(
      ({ composing }) => useDocumentPassageSession('owner', '1', '4', { composing }),
      { initialProps: { composing: true } },
    );
    const session = records.sessions[0]!;
    act(() => session.dirty());
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(session.save).not.toHaveBeenCalled();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    act(() => window.dispatchEvent(new Event('offline')));
    hook.rerender({ composing: false });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(session.save).not.toHaveBeenCalled();
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    act(() => window.dispatchEvent(new Event('online')));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(session.save).toHaveBeenCalledTimes(1);
  });
  it('rebinds lifecycle retention to the newly authenticated owner without invoking old owner events', () => {
    const hook = renderHook(({ owner }) => useDocumentPassageSession(owner, '1', '4'), {
      initialProps: { owner: 'first-owner' },
    });
    const old = records.sessions[0]!;
    hook.rerender({ owner: 'second-owner' });
    const next = records.sessions[1]!;
    act(() => transition('pagehide', true));
    expect(old.dispose).toHaveBeenCalledTimes(1);
    expect(old.retainDraft).not.toHaveBeenCalled();
    expect(next.retainDraft).toHaveBeenCalledTimes(1);
    expect(next.identity.userId).toBe('second-owner');
    expect(old.save).not.toHaveBeenCalled();
  });
});
