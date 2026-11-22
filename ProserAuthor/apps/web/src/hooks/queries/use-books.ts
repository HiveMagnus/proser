'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { useBookCreation } from '@/hooks/use-book-creation';
import type { BookCreationRequest } from '@/lib/book-creation-intent';
import { listBooks } from '@/lib/api';

export const bookKeys = {
  all: ['books'] as const,
  list: (userId?: string) => [...bookKeys.all, 'list', userId ?? null] as const,
  detail: (id: string) => [...bookKeys.all, id] as const,
};

export function useBooks() {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  return useQuery({
    queryKey: bookKeys.list(userId),
    enabled: !!userId,
    queryFn: async () => {
      const { data } = await listBooks(userId);
      return data;
    },
  });
}

export function useCreateBook() {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const qc = useQueryClient();
  const creation = useBookCreation(userId);
  const mutation = useMutation({
    retry: 0,
    networkMode: 'always',
    mutationFn: (input: BookCreationRequest) => {
      if (!creation.session) throw new Error('Authenticate before creating a project.');
      return creation.session.create(input);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: bookKeys.list(userId) }),
  });
  const recoverCreation = async () => {
    if (!creation.session) throw new Error('Authenticate before recovering project creation.');
    const result = await creation.session.recover();
    if (result) await qc.invalidateQueries({ queryKey: bookKeys.list(userId) });
    return result;
  };
  const retryCreation = async () => {
    if (!creation.session) throw new Error('Authenticate before continuing project creation.');
    const result = await creation.session.retry();
    await qc.invalidateQueries({ queryKey: bookKeys.list(userId) });
    return result;
  };
  return { ...mutation, creation, recoverCreation, retryCreation };
}
