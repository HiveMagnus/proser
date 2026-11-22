'use client';

import { useQuery } from '@tanstack/react-query';
import { getWritingStats } from '@/lib/api';

export const analyticsKeys = {
  all: ['analytics'] as const,
  stats: (bookId?: string, days?: number) =>
    [...analyticsKeys.all, 'stats', bookId ?? 'all', days ?? 30] as const,
};

export function useWritingStats(bookId?: string | null, days = 30) {
  return useQuery({
    queryKey: analyticsKeys.stats(bookId ?? undefined, days),
    queryFn: async () => {
      const { data } = await getWritingStats(bookId ?? undefined, days);
      return data;
    },
  });
}
