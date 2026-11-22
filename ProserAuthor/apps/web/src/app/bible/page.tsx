'use client';

import { useEffect, useState } from 'react';
import { useProtectedRouter as useRouter } from '@/hooks/use-protected-router';
import {
  BookOpen,
  Plus,
  Search,
  Users,
  MapPin,
  Sword,
  Crown,
  Calendar,
  ScrollText,
  Network,
  History,
  Crosshair,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input, Textarea } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/ui/data-display';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { RelationshipGraph } from '@/components/relationship-graph';
import { useWorkspace } from '@/contexts/workspace-context';
import { useBooks } from '@/hooks/queries/use-books';
import { useCodexEntries, useCreateCodexEntry } from '@/hooks/queries/use-codex';
import { AsyncBoundary } from '@/components/ui/async-boundary';
import { PageTransition, FadeIn } from '@/components/motion/primitives';
import type { CodexEntry } from '@/lib/api';

const entryTypeIcons: Record<string, React.ComponentType<{ className?: string }>> = {
  character: Users,
  location: MapPin,
  lore: ScrollText,
  item: Sword,
  faction: Crown,
  event: Calendar,
  rule: ScrollText,
  culture: ScrollText,
  relationship: Network,
};

const entryTypeColors: Record<
  string,
  'accent' | 'info' | 'success' | 'warning' | 'danger' | 'default'
> = {
  character: 'accent',
  location: 'success',
  lore: 'default',
  item: 'info',
  faction: 'warning',
  event: 'danger',
  rule: 'default',
  culture: 'default',
  relationship: 'info',
};

const ENTRY_TYPES = [
  'character',
  'location',
  'lore',
  'item',
  'faction',
  'event',
  'rule',
  'culture',
  'relationship',
] as const;

function parseAttributes(attrs: string | null): Record<string, string> {
  if (!attrs) return {};
  try {
    return JSON.parse(attrs);
  } catch {
    return {};
  }
}

export default function StoryBiblePage() {
  const router = useRouter();
  const { activeBookId, activeBookTitle, setActiveBookId, setActiveBookTitle } = useWorkspace();
  const { data: books = [] } = useBooks();
  const { data: entries = [], isLoading, error, refetch } = useCodexEntries(activeBookId);
  const createMutation = useCreateCodexEntry(activeBookId ?? '');

  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState('all');
  const [pageView, setPageView] = useState<'entries' | 'relationships' | 'canon' | 'timeline'>(
    'entries',
  );

  // Create dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<string>('character');
  const [newDesc, setNewDesc] = useState('');

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !activeBookId) return;
    createMutation.mutate(
      {
        entryType: newType,
        entryName: newName.trim(),
        entryDescription: newDesc.trim() || undefined,
      },
      {
        onSuccess: () => {
          setCreateOpen(false);
          setNewName('');
          setNewType('character');
          setNewDesc('');
        },
      },
    );
  };

  const handleEntryClick = (entry: CodexEntry) => {
    router.push(`/bible/${entry.id}?bookId=${encodeURIComponent(entry.bookId)}`);
  };

  // Filter entries
  const filtered = entries.filter((entry: CodexEntry) => {
    const matchesSearch =
      !searchTerm ||
      entry.entryName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (entry.entryDescription ?? '').toLowerCase().includes(searchTerm.toLowerCase());
    const matchesType = activeTab === 'all' || entry.entryType === activeTab;
    return matchesSearch && matchesType;
  });

  const relationshipEntries = entries.filter((e: CodexEntry) => e.entryType === 'relationship');
  const ruleEntries = entries.filter((e: CodexEntry) => e.entryType === 'rule');
  const eventEntries = entries.filter((e: CodexEntry) => e.entryType === 'event');

  useEffect(() => {
    if (books.length === 0) return;
    const activeBook = books.find((book) => book.id === activeBookId) ?? null;
    if (activeBook) {
      if (activeBookTitle !== activeBook.title) {
        setActiveBookTitle(activeBook.title);
      }
      return;
    }

    const fallbackBook = books[0];
    if (!fallbackBook) return;
    setActiveBookId(fallbackBook.id);
    setActiveBookTitle(fallbackBook.title);
  }, [activeBookId, activeBookTitle, books, setActiveBookId, setActiveBookTitle]);

  return (
    <PageTransition>
      <div className="space-y-6">
        {/* ── Header ─────────────────────────── */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="font-[--font-display] text-[length:--text-3xl] font-bold tracking-tight text-text-primary">
              Story Bible
            </h1>
            <p className="mt-1 text-[length:--text-sm] text-text-secondary">
              Characters, locations, factions, and lore — your world&apos;s source of truth.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {books.length > 1 && (
              <Select value={activeBookId ?? ''} onValueChange={setActiveBookId}>
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="Select book" />
                </SelectTrigger>
                <SelectContent>
                  {books.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button disabled={!activeBookId}>
                  <Plus className="mr-2 size-4" />
                  New Entry
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>New Codex Entry</DialogTitle>
                  <DialogDescription>
                    Add a character, location, item, or other world element.
                  </DialogDescription>
                </DialogHeader>
                <form className="space-y-4 mt-4" onSubmit={handleCreate}>
                  <div>
                    <label className="text-[length:--text-sm] font-medium text-text-primary">
                      Name
                    </label>
                    <Input
                      className="mt-1.5"
                      placeholder="Entry name..."
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      required
                    />
                  </div>
                  <div>
                    <label className="text-[length:--text-sm] font-medium text-text-primary">
                      Type
                    </label>
                    <Select value={newType} onValueChange={setNewType}>
                      <SelectTrigger className="mt-1.5">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ENTRY_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t.charAt(0).toUpperCase() + t.slice(1)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-[length:--text-sm] font-medium text-text-primary">
                      Description
                    </label>
                    <Textarea
                      className="mt-1.5"
                      placeholder="Brief description..."
                      value={newDesc}
                      onChange={(e) => setNewDesc(e.target.value)}
                      rows={3}
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button type="button" variant="secondary" onClick={() => setCreateOpen(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={createMutation.isPending || !newName.trim()}>
                      {createMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                      Create
                    </Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* ── View Selector ──────────────────── */}
        <div className="flex items-center gap-2 border-b border-border-muted pb-3 overflow-x-auto">
          {(
            [
              { key: 'entries', icon: BookOpen, label: 'Entries' },
              { key: 'relationships', icon: Network, label: 'Relationships' },
              { key: 'canon', icon: Crosshair, label: 'Canon Facts' },
              { key: 'timeline', icon: History, label: 'Timeline' },
            ] as const
          ).map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              onClick={() => setPageView(key)}
              className={`flex items-center gap-1.5 rounded-[--radius-md] px-3 py-2 text-[length:--text-sm] font-medium transition-colors whitespace-nowrap cursor-pointer ${
                pageView === key
                  ? 'bg-accent-500/10 text-accent-300'
                  : 'text-text-muted hover:text-text-primary hover:bg-surface-sunken'
              }`}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </div>

        {/* ── Entries View ─────────────────── */}
        {pageView === 'entries' && (
          <>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative max-w-sm flex-1">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted" />
                <Input
                  placeholder="Search entries..."
                  className="pl-10"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
              </div>
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="flex-wrap">
                  <TabsTrigger value="all">All</TabsTrigger>
                  {ENTRY_TYPES.map((t) => {
                    const Icon = entryTypeIcons[t] ?? BookOpen;
                    return (
                      <TabsTrigger key={t} value={t}>
                        <Icon className="mr-1 size-3.5" />
                        {t.charAt(0).toUpperCase() + t.slice(1)}
                      </TabsTrigger>
                    );
                  })}
                </TabsList>
              </Tabs>
            </div>

            <AsyncBoundary
              isLoading={isLoading}
              error={error}
              onRetry={() => {
                void refetch();
              }}
              isEmpty={filtered.length === 0}
              emptyTitle="No entries"
              emptyDescription={
                activeBookId ? 'Create your first codex entry.' : 'Select a book first.'
              }
              emptyIcon={<BookOpen className="size-6" />}
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {filtered.map((entry: CodexEntry) => {
                  const Icon = entryTypeIcons[entry.entryType] ?? BookOpen;
                  const attrs = parseAttributes(entry.attributes);
                  return (
                    <Card
                      key={entry.id}
                      className="group cursor-pointer transition-all hover:border-accent-500/40"
                      onClick={() => handleEntryClick(entry)}
                    >
                      <CardContent className="py-4">
                        <div className="flex items-start gap-3">
                          <div className="flex size-9 shrink-0 items-center justify-center rounded-[--radius-md] bg-surface-sunken">
                            <Icon className="size-4 text-text-muted" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <h3 className="text-[length:--text-sm] font-semibold text-text-primary truncate">
                                {entry.entryName}
                              </h3>
                              <Badge
                                variant={entryTypeColors[entry.entryType] ?? 'default'}
                                className="text-[10px] shrink-0"
                              >
                                {entry.entryType}
                              </Badge>
                            </div>
                            {entry.entryDescription && (
                              <p className="mt-1 text-[length:--text-xs] text-text-secondary line-clamp-2">
                                {entry.entryDescription}
                              </p>
                            )}
                            {Object.keys(attrs).length > 0 && (
                              <div className="mt-2 flex flex-wrap gap-1">
                                {Object.entries(attrs)
                                  .slice(0, 3)
                                  .map(([k, v]) => (
                                    <span
                                      key={k}
                                      className="text-[9px] px-1.5 py-0.5 rounded-[--radius-sm] bg-surface-sunken text-text-muted"
                                    >
                                      {k}: {v}
                                    </span>
                                  ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </AsyncBoundary>
          </>
        )}

        {/* ── Relationships View ───────────── */}
        {pageView === 'relationships' && (
          <FadeIn>
            {relationshipEntries.length === 0 ? (
              <EmptyState
                icon={<Network className="size-6" />}
                title="No relationships"
                description="Create relationship entries to visualize character connections."
              />
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle>Character Relationships</CardTitle>
                </CardHeader>
                <CardContent className="h-96">
                  <RelationshipGraph
                    entries={entries}
                    bookId={activeBookId ?? ''}
                    isDemo={!activeBookId}
                    onDataChanged={() => {}}
                  />
                </CardContent>
              </Card>
            )}
          </FadeIn>
        )}

        {/* ── Canon Facts View ─────────────── */}
        {pageView === 'canon' && (
          <FadeIn>
            {ruleEntries.length === 0 ? (
              <EmptyState
                icon={<Crosshair className="size-6" />}
                title="No canon facts"
                description="Add 'rule' type entries to track established world facts."
              />
            ) : (
              <div className="space-y-3">
                {ruleEntries.map((entry: CodexEntry) => {
                  const attrs = parseAttributes(entry.attributes);
                  return (
                    <Card
                      key={entry.id}
                      className="cursor-pointer hover:border-border-strong transition-all"
                      onClick={() => handleEntryClick(entry)}
                    >
                      <CardContent className="py-4">
                        <div className="flex items-center gap-2">
                          <ScrollText className="size-4 text-text-muted shrink-0" />
                          <h3 className="text-[length:--text-sm] font-semibold text-text-primary">
                            {entry.entryName}
                          </h3>
                          {attrs.certainty && (
                            <Badge variant="info" className="text-[10px]">
                              {attrs.certainty}
                            </Badge>
                          )}
                        </div>
                        {entry.entryDescription && (
                          <p className="mt-1.5 ml-6 text-[length:--text-sm] text-text-secondary">
                            {entry.entryDescription}
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </FadeIn>
        )}

        {/* ── Timeline View ────────────────── */}
        {pageView === 'timeline' && (
          <FadeIn>
            {eventEntries.length === 0 ? (
              <EmptyState
                icon={<History className="size-6" />}
                title="No events"
                description="Add 'event' type entries to build your story timeline."
              />
            ) : (
              <div className="relative ml-4 border-l-2 border-border-muted pl-6 space-y-6">
                {eventEntries.map((entry: CodexEntry) => {
                  const attrs = parseAttributes(entry.attributes);
                  return (
                    <div key={entry.id} className="relative">
                      <div className="absolute -left-7.75 top-1 size-4 rounded-full border-2 border-accent-500 bg-surface-base" />
                      <Card
                        className="cursor-pointer hover:border-border-strong transition-all"
                        onClick={() => handleEntryClick(entry)}
                      >
                        <CardContent className="py-3">
                          <h3 className="text-[length:--text-sm] font-semibold text-text-primary">
                            {entry.entryName}
                          </h3>
                          {entry.entryDescription && (
                            <p className="mt-1 text-[length:--text-xs] text-text-secondary">
                              {entry.entryDescription}
                            </p>
                          )}
                          {attrs.scene && (
                            <p className="mt-1 text-[length:--text-xs] text-text-muted">
                              Scene: {attrs.scene}
                            </p>
                          )}
                        </CardContent>
                      </Card>
                    </div>
                  );
                })}
              </div>
            )}
          </FadeIn>
        )}
      </div>
    </PageTransition>
  );
}
