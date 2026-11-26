'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import {
  getRecommendations,
  getStoryArchetypes,
  getWritingStats,
  setWritingGoal,
  type WritingGoal,
} from '@/lib/api';

export const writingKeys = {
  all: ['writing'] as const,
  stats: (userId: string | undefined, bookId: string | null, days: number) =>
    [...writingKeys.all, 'stats', userId ?? null, bookId, days] as const,
  recommendations: (userId: string | undefined, bookId: string | null) =>
    [...writingKeys.all, 'recommendations', userId ?? null, bookId] as const,
  archetypes: ['plot', 'archetypes'] as const,
};

export function useWritingStats(bookId: string | null, days = 30) {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  return useQuery({
    queryKey: writingKeys.stats(userId, bookId, days),
    enabled: !!userId && !!bookId,
    queryFn: ({ signal }) => getWritingStats(bookId!, days, signal),
  });
}

export function useRecommendations(bookId: string | null) {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  return useQuery({
    queryKey: writingKeys.recommendations(userId, bookId),
    enabled: !!userId && !!bookId,
    queryFn: ({ signal }) => getRecommendations(bookId!, signal),
  });
}

export function useSetWritingGoal(bookId: string | null) {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const client = useQueryClient();
  return useMutation({
    mutationFn: (goal: WritingGoal) => {
      if (!bookId || !userId) throw new Error('Choose a book before setting a goal.');
      return setWritingGoal(bookId, goal, userId);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: writingKeys.all }),
  });
}

export function useStoryArchetypes() {
  return useQuery({
    queryKey: writingKeys.archetypes,
    queryFn: ({ signal }) => getStoryArchetypes(signal),
    staleTime: 60 * 60 * 1000,
  });
}
