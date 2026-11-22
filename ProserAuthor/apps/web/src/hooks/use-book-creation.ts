'use client';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BookCreationSession, type BookCreationState } from '@/lib/book-creation-session';
export function useBookCreation(userId?: string) {
  const current = useRef(userId);
  current.current = userId;
  const [state, setState] = useState<BookCreationState>();
  const lease = useMemo(() => {
    const owner = { active: true };
    return {
      owner,
      session: userId
        ? new BookCreationSession(
            userId,
            () => owner.active && current.current === userId,
            setState,
          )
        : undefined,
    };
  }, [userId]);
  const session = lease.session;
  useLayoutEffect(() => {
    lease.owner.active = true;
    void session?.load().catch(() => undefined);
    return () => {
      lease.owner.active = false;
    };
  }, [lease, session]);
  const visible = state?.userId === userId && !!userId ? state : undefined;
  return {
    session,
    ready: !!visible?.ready,
    busy: !!visible?.busy,
    pending: visible?.pending,
    retryAllowed: !!visible?.retryAllowed,
    error: visible?.error,
  };
}
