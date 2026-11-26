'use client';

import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useWorkspace } from '@/contexts/workspace-context';
import { useBooks } from '@/hooks/queries/use-books';
import { useStoryArchetypes } from '@/hooks/queries/use-writing-stats';

/** The open book's story archetype and the shapes Factory can write toward. */
export function StoryArchetypePanel() {
  const { activeBookId } = useWorkspace();
  const { data: books = [] } = useBooks();
  const { data: archetypes = [], isLoading, error } = useStoryArchetypes();
  const book = books.find((item) => item.id === activeBookId);
  const chosen = archetypes.find((item) => item.id === book?.archetype);

  return (
    <Card aria-labelledby="story-archetype-heading">
      <CardHeader>
        <CardTitle id="story-archetype-heading">Story archetype</CardTitle>
        <CardDescription>
          {chosen
            ? `${book?.title ?? 'This book'} follows ${chosen.name}. Generation and reviews use it as the story's shape.`
            : book
              ? `${book.title} has no archetype yet. Choose one with Edit Project on the Dashboard.`
              : 'Open a book from the Dashboard to see its archetype.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {chosen ? (
          <p className="text-[length:--text-sm] text-text-secondary">{chosen.description}</p>
        ) : null}
        {error ? (
          <p role="alert" className="text-[length:--text-sm] text-red-300">
            Archetypes are unavailable.
          </p>
        ) : isLoading ? (
          <p className="text-[length:--text-sm] text-text-muted">Loading archetypes…</p>
        ) : (
          <details>
            <summary className="cursor-pointer text-[length:--text-sm] text-text-primary">
              All {archetypes.length} archetypes
            </summary>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {archetypes.map((item) => (
                <li key={item.id} className="rounded-[--radius-md] border border-border-muted p-3">
                  <p className="flex items-center gap-2 text-[length:--text-sm] font-medium text-text-primary">
                    {item.name}
                    {item.id === chosen?.id ? <Badge variant="accent">This book</Badge> : null}
                  </p>
                  <p className="mt-1 text-[length:--text-xs] text-text-secondary">
                    {item.description}
                  </p>
                </li>
              ))}
            </ul>
          </details>
        )}
        {book && !chosen ? (
          <Link href="/" className="text-[length:--text-sm] text-accent-400 hover:underline">
            Go to the Dashboard
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}
