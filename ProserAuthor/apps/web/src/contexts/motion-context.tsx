'use client';

import * as React from 'react';

interface MotionCtx {
  shouldAnimate: boolean;
  cinematicMotion: boolean;
  setCinematicMotion: (enabled: boolean) => void;
}

const MOTION_KEY = 'proser-cinematic-motion';
const MotionContext = React.createContext<MotionCtx | null>(null);

export function MotionProvider({ children }: { children: React.ReactNode }) {
  const [prefersReduced, setPrefersReduced] = React.useState(false);
  const [cinematicMotion, setCinematicMotionState] = React.useState(true);

  React.useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setPrefersReduced(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  React.useEffect(() => {
    try {
      const stored = localStorage.getItem(MOTION_KEY);
      if (stored !== null) setCinematicMotionState(stored === 'true');
    } catch {
      /* ignore */
    }
  }, []);

  const setCinematicMotion = React.useCallback((enabled: boolean) => {
    setCinematicMotionState(enabled);
    try {
      localStorage.setItem(MOTION_KEY, String(enabled));
    } catch {
      /* ignore */
    }
  }, []);

  const shouldAnimate = !prefersReduced && cinematicMotion;

  const value = React.useMemo<MotionCtx>(
    () => ({ shouldAnimate, cinematicMotion, setCinematicMotion }),
    [shouldAnimate, cinematicMotion, setCinematicMotion],
  );

  return <MotionContext value={value}>{children}</MotionContext>;
}

export function useMotion(): MotionCtx {
  const ctx = React.useContext(MotionContext);
  if (!ctx) throw new Error('useMotion must be used within MotionProvider');
  return ctx;
}
