'use client';
import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { requestDocumentRoute } from '@/lib/document-history-navigation';
/** All application navigation shares the active document's acknowledgement fence. */
export function useProtectedRouter() {
  const router = useRouter();
  return useMemo(
    () => ({
      ...router,
      push: (...args: Parameters<typeof router.push>) => {
        if (requestDocumentRoute(args[0], 'push')) router.push(...args);
      },
      replace: (...args: Parameters<typeof router.replace>) => {
        if (requestDocumentRoute(args[0], 'replace')) router.replace(...args);
      },
    }),
    [router],
  );
}
