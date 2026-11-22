'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createCodexEntry, deleteCodexEntry, listCodexEntries, updateCodexEntry } from '@/lib/api';
import type { CreateCodexInput, UpdateCodexInput } from '@/lib/api';

export const codexKeys = {
  all: ['codex'] as const,
  list: (bookId: string, type?: string) => [...codexKeys.all, bookId, type ?? 'all'] as const,
};

export function useCodexEntries(bookId: string | null, entryType?: string) {
  return useQuery({
    queryKey: codexKeys.list(bookId ?? '', entryType),
    queryFn: async () => {
      if (!bookId) return [];
      const { data } = await listCodexEntries(bookId, { entryType, limit: 200 });
      return data;
    },
    enabled: !!bookId,
  });
}

export function useCreateCodexEntry(bookId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateCodexInput) => {
      if (!bookId) throw new Error('No book selected');
      const { data } = await createCodexEntry(bookId, input);
      return data;
    },
    onSuccess: () => {
      if (bookId) qc.invalidateQueries({ queryKey: codexKeys.list(bookId) });
    },
  });
}

export function useUpdateCodexEntry(bookId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateCodexInput }) => {
      if (!bookId) throw new Error('No book selected');
      const { data } = await updateCodexEntry(bookId, id, input);
      return data;
    },
    onSuccess: () => {
      if (bookId) qc.invalidateQueries({ queryKey: codexKeys.list(bookId) });
    },
  });
}

export function useDeleteCodexEntry(bookId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!bookId) throw new Error('No book selected');
      await deleteCodexEntry(bookId, id);
    },
    onSuccess: () => {
      if (bookId) qc.invalidateQueries({ queryKey: codexKeys.list(bookId) });
    },
  });
}
