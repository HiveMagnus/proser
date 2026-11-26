'use client';

import { useQuery } from '@tanstack/react-query';
import { getPlotThreads } from '@/lib/api';

export const plotKeys = {
  all: ['plot'] as const,
  threads: (bookId: string) => [...plotKeys.all, 'threads', bookId] as const,
};

export function usePlotThreads(bookId: string | null) {
  return useQuery({
    queryKey: plotKeys.threads(bookId ?? ''),
    queryFn: async () => {
      if (!bookId) return [];
      const { data } = await getPlotThreads(bookId);
      return data;
    },
    enabled: !!bookId,
  });
}
