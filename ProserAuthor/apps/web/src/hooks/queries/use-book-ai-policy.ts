'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { getAiDisabledBookIds, getBookAiPolicy, setBookAiPolicy } from '@/lib/api';

export const bookAiKeys = {
  all: ['book-ai-policy'] as const,
  book: (userId: string | undefined, bookId: string | null) =>
    [...bookAiKeys.all, 'book', userId ?? null, bookId] as const,
  disabled: (userId: string | undefined) =>
    [...bookAiKeys.all, 'disabled', userId ?? null] as const,
};

export function useBookAiPolicy(bookId: string | null) {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  return useQuery({
    queryKey: bookAiKeys.book(userId, bookId),
    enabled: !!userId && !!bookId,
    queryFn: ({ signal }) => getBookAiPolicy(bookId!, signal),
  });
}

/** IDs of the signed-in writer's books that have AI switched off. */
export function useAiDisabledBookIds() {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  return useQuery({
    queryKey: bookAiKeys.disabled(userId),
    enabled: !!userId,
    queryFn: ({ signal }) => getAiDisabledBookIds(signal),
  });
}

export function useSetBookAiPolicy(bookId: string | null) {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const client = useQueryClient();
  return useMutation({
    mutationFn: (aiDisabled: boolean) => {
      if (!bookId || !userId) throw new Error('Choose a book before changing its AI setting.');
      return setBookAiPolicy(bookId, aiDisabled, userId);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: bookAiKeys.all }),
  });
}
