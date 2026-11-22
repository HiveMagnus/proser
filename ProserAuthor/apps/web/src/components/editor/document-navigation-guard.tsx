'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  registerDocumentNavigationFence,
  resumeDocumentHistory,
  type DocumentNavigationIntent,
} from '@/lib/document-history-navigation';
import { Button } from '@/components/ui/button';

/** Keep same-tab link navigation inside the acknowledged document session.
 * Reload/close protection and the durable journal belong to the session hook. */
export function DocumentNavigationGuard({ dirty }: { dirty: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState<DocumentNavigationIntent>();
  const currentDirty = useRef(dirty);
  currentDirty.current = dirty;
  useEffect(
    () =>
      registerDocumentNavigationFence({ dirty: () => currentDirty.current, blocked: setPending }),
    [],
  );
  useEffect(() => {
    if (!dirty) return;
    const capture = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor =
        event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (
        !anchor ||
        anchor.hasAttribute('download') ||
        (anchor.target && anchor.target !== '_self')
      )
        return;
      const target = new URL(anchor.href, window.location.href);
      if (
        target.origin !== window.location.origin ||
        (target.pathname === window.location.pathname && target.search === window.location.search)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setPending({
        kind: 'route',
        href: `${target.pathname}${target.search}${target.hash}`,
        method: 'push',
      });
    };
    document.addEventListener('click', capture, true);
    return () => document.removeEventListener('click', capture, true);
  }, [dirty]);
  if (!pending) return null;
  return (
    <section
      aria-label="Unsaved route navigation"
      role="alert"
      className="sticky top-2 z-40 space-y-2 rounded border border-accent-500 bg-surface-raised p-4 shadow-lg"
    >
      <p>The current document has unacknowledged work. Save or reconcile it before leaving.</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={() => setPending(undefined)}>
          Keep editing
        </Button>
        <Button
          type="button"
          disabled={dirty}
          onClick={() => {
            const route = pending;
            setPending(undefined);
            if (route.kind === 'history') resumeDocumentHistory(route.index);
            else router[route.method](route.href);
          }}
        >
          Continue after saving
        </Button>
      </div>
    </section>
  );
}
