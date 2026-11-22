'use client';

import { useQuery } from '@tanstack/react-query';
import { getRecommendations } from '@/lib/api';

export const recommendationKeys = {
  all: ['recommendations'] as const,
  book: (bookId: string) => [...recommendationKeys.all, bookId] as const,
};

export function useRecommendations(bookId: string | null) {
  return useQuery({
    queryKey: recommendationKeys.book(bookId ?? ''),
    queryFn: async () => {
      if (!bookId) return [];
      const { data } = await getRecommendations(bookId);
      return data;
    },
    enabled: !!bookId,
    refetchInterval: 5 * 60 * 1000, // poll every 5 minutes
  });
}
