'use client';

import { useEffect } from 'react';
import { useProtectedRouter as useRouter } from '@/hooks/use-protected-router';

const navRoutes: Record<string, string> = {
  '1': '/',
  '2': '/bible',
  '3': '/plot',
  '4': '/manuscript',
  '5': '/continuity',
  '6': '/quality',
  '8': '/publish',
};

export function useNavigationShortcuts(enabled = true) {
  const router = useRouter();

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const route = navRoutes[e.key];
      if (route) {
        e.preventDefault();
        router.push(route);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [enabled, router]);
}
