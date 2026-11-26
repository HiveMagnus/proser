'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { bookKeys } from '@/hooks/queries/use-books';
import { listDeletedBooks, restoreDeletedBook, type DeletedBook } from '@/lib/api';

export const trashKeys = { list: (userId?: string) => ['books', 'trash', userId ?? null] as const };

/** Deleted books, each of which can be restored to the revision before it was deleted. */
export function BookTrash() {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  const client = useQueryClient();
  const { data: books = [] } = useQuery({
    queryKey: trashKeys.list(userId),
    enabled: !!userId,
    queryFn: ({ signal }) => listDeletedBooks(signal),
  });
  const restore = useMutation({
    mutationFn: (book: DeletedBook) => restoreDeletedBook(book, userId!),
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: trashKeys.list(userId) });
      await client.invalidateQueries({ queryKey: bookKeys.list(userId) });
    },
  });
  if (books.length === 0) return null;

  return (
    <details className="rounded-[--radius-lg] border border-border-muted p-4">
      <summary className="flex cursor-pointer items-center gap-2 text-[length:--text-sm] font-medium text-text-primary">
        <Trash2 className="size-4" aria-hidden="true" />
        Deleted books ({books.length})
      </summary>
      <p className="mt-2 text-[length:--text-xs] text-text-muted">
        Restoring a book brings back its scenes, Story Bible and layout exactly as they were when it
        was deleted.
      </p>
      <ul className="mt-3 divide-y divide-border-muted">
        {books.map((book) => (
          <li key={book.id} className="flex items-center justify-between gap-3 py-2">
            <span className="min-w-0">
              <span className="block truncate text-[length:--text-sm] text-text-primary">
                {book.title}
              </span>
              <span className="text-[length:--text-xs] text-text-muted">
                Deleted {new Date(book.deletedAt).toLocaleString()}
              </span>
            </span>
            <Button
              size="sm"
              variant="secondary"
              disabled={restore.isPending}
              onClick={() => restore.mutate(book)}
            >
              <RotateCcw className="mr-1.5 size-3.5" aria-hidden="true" />
              Restore
            </Button>
          </li>
        ))}
      </ul>
      {restore.isError ? (
        <p role="alert" className="mt-2 text-[length:--text-sm] text-red-300">
          {restore.error instanceof Error
            ? restore.error.message
            : 'The book could not be restored.'}
        </p>
      ) : null}
    </details>
  );
}
