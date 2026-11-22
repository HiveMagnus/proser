'use client';

import { useQuery } from '@tanstack/react-query';
import { getArchetypes, getBeatCoverage, getPlotThreads } from '@/lib/api';

export const plotKeys = {
  all: ['plot'] as const,
  archetypes: (genre?: string) => [...plotKeys.all, 'archetypes', genre ?? 'all'] as const,
  coverage: (bookId: string) => [...plotKeys.all, 'coverage', bookId] as const,
  threads: (bookId: string) => [...plotKeys.all, 'threads', bookId] as const,
};

export function useArchetypes(genre?: string) {
  return useQuery({
    queryKey: plotKeys.archetypes(genre),
    queryFn: async () => {
      const { data } = await getArchetypes(genre);
      return data;
    },
  });
}

export function useBeatCoverage(bookId: string | null) {
  return useQuery({
    queryKey: plotKeys.coverage(bookId ?? ''),
    queryFn: async () => {
      if (!bookId) return null;
      const { data } = await getBeatCoverage(bookId);
      return data;
    },
    enabled: !!bookId,
  });
}

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
