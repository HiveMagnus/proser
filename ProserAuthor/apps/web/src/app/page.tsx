'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { useQueryClient } from '@tanstack/react-query';
import { useDocumentBookCatalog } from '@/hooks/use-document-book-catalog';
import type { BookCatalogSnapshot } from '@/lib/document-book-catalog-journal';
import {
  BookOpen,
  Clock,
  FileText,
  Loader2,
  Plus,
  MoreVertical,
  Feather,
  Sparkles,
  Pencil,
  Trash2,
  ArrowRight,
  PenTool,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { StatCard } from '@/components/ui/data-display';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Input, Textarea } from '@/components/ui/input';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { useBooks, useCreateBook, bookKeys } from '@/hooks/queries/use-books';
import { useWorkspace } from '@/contexts/workspace-context';
import { AsyncBoundary } from '@/components/ui/async-boundary';
import {
  PageTransition,
  FadeIn,
  AnimatedNumber,
  ProgressRing,
} from '@/components/motion/primitives';
import type { Book } from '@/lib/api';

const statusColors: Record<string, 'default' | 'accent' | 'success' | 'warning' | 'info'> = {
  draft: 'default',
  outlining: 'info',
  writing: 'accent',
  revising: 'warning',
  complete: 'success',
};

// ── Genre → Archetype mapping (from story-engine) ────────
const GENRE_ARCHETYPES: Record<string, Array<{ id: string; name: string }>> = {
  fantasy: [
    { id: 'overcoming-the-monster', name: 'Overcoming the Monster' },
    { id: 'the-quest', name: 'The Quest' },
    { id: 'voyage-and-return', name: 'Voyage and Return' },
    { id: 'rebirth', name: 'Rebirth' },
    { id: 'forbidden-love', name: 'Forbidden Love' },
    { id: 'transformation', name: 'Transformation' },
    { id: 'sacrifice', name: 'Sacrifice' },
    { id: 'fated-mates', name: 'Fated Mates' },
    { id: 'court-intrigue-romantasy', name: 'Court Intrigue Romantasy' },
    { id: 'cursed-bond', name: 'Cursed Bond' },
    { id: 'grimdark-power-spiral', name: 'Grimdark Power Spiral' },
    { id: 'eldritch-pact', name: 'Eldritch Pact' },
    { id: 'gothic-retelling', name: 'Gothic Retelling' },
  ],
  'sci-fi': [
    { id: 'overcoming-the-monster', name: 'Overcoming the Monster' },
    { id: 'the-quest', name: 'The Quest' },
    { id: 'voyage-and-return', name: 'Voyage and Return' },
    { id: 'transformation', name: 'Transformation' },
    { id: 'discovery', name: 'Discovery' },
    { id: 'eldritch-pact', name: 'Eldritch Pact' },
  ],
  thriller: [
    { id: 'overcoming-the-monster', name: 'Overcoming the Monster' },
    { id: 'tragedy', name: 'Tragedy' },
    { id: 'underdog', name: 'The Underdog' },
    { id: 'revenge', name: 'Revenge' },
    { id: 'mystery', name: 'Mystery' },
    { id: 'rise-and-fall', name: 'Rise and Fall' },
    { id: 'discovery', name: 'Discovery' },
    { id: 'villain-romance', name: 'Villain Romance' },
  ],
  romance: [
    { id: 'rags-to-riches', name: 'Rags to Riches' },
    { id: 'comedy', name: 'Comedy' },
    { id: 'rebirth', name: 'Rebirth' },
    { id: 'love-story', name: 'Love Story' },
    { id: 'forbidden-love', name: 'Forbidden Love' },
    { id: 'sacrifice', name: 'Sacrifice' },
    { id: 'fated-mates', name: 'Fated Mates' },
    { id: 'monster-paramour', name: 'Monster Paramour' },
    { id: 'villain-romance', name: 'Villain Romance' },
    { id: 'underworld-romance', name: 'Underworld Romance' },
    { id: 'dark-academia-romance', name: 'Dark Academia Romance' },
    { id: 'why-choose-poly-bond', name: 'Why Choose / Poly Bond' },
    { id: 'cursed-bond', name: 'Cursed Bond' },
    { id: 'horromance', name: 'Horromance' },
  ],
  literary: [
    { id: 'rags-to-riches', name: 'Rags to Riches' },
    { id: 'voyage-and-return', name: 'Voyage and Return' },
    { id: 'comedy', name: 'Comedy' },
    { id: 'tragedy', name: 'Tragedy' },
    { id: 'rebirth', name: 'Rebirth' },
    { id: 'love-story', name: 'Love Story' },
    { id: 'forbidden-love', name: 'Forbidden Love' },
    { id: 'transformation', name: 'Transformation' },
    { id: 'sacrifice', name: 'Sacrifice' },
    { id: 'discovery', name: 'Discovery' },
    { id: 'rise-and-fall', name: 'Rise and Fall' },
    { id: 'dark-academia-romance', name: 'Dark Academia Romance' },
  ],
  mystery: [
    { id: 'mystery', name: 'Mystery' },
    { id: 'discovery', name: 'Discovery' },
    { id: 'rise-and-fall', name: 'Rise and Fall' },
  ],
  horror: [
    { id: 'overcoming-the-monster', name: 'Overcoming the Monster' },
    { id: 'transformation', name: 'Transformation' },
    { id: 'monster-paramour', name: 'Monster Paramour' },
    { id: 'gothic-retelling', name: 'Gothic Retelling' },
    { id: 'horromance', name: 'Horromance' },
    { id: 'eldritch-pact', name: 'Eldritch Pact' },
  ],
};

function formatRelativeTime(dateStr: string) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

export default function DashboardPage() {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  return userId ? (
    <OwnedDashboard key={userId} userId={userId} />
  ) : (
    <p role="status">Authenticate to view your projects.</p>
  );
}

function OwnedDashboard({ userId }: { userId: string }) {
  const { data: books = [], isLoading, error } = useBooks();
  const { activeBookId, activeBookTitle, setActiveBookId, setActiveBookTitle } = useWorkspace();
  const createBookMutation = useCreateBook();
  const queryClient = useQueryClient();
  const catalog = useDocumentBookCatalog(userId);
  const preparationEpoch = useRef(0);
  const dialogTarget = useRef<
    { epoch: number; userId: string; bookId: string; kind: 'edit' | 'delete' } | undefined
  >(undefined);
  useLayoutEffect(
    () => () => {
      preparationEpoch.current += 1;
      dialogTarget.current = undefined;
    },
    [],
  );
  const [editSnapshot, setEditSnapshot] = useState<BookCatalogSnapshot>();
  const [deleteSnapshot, setDeleteSnapshot] = useState<BookCatalogSnapshot>();
  const [catalogPreparing, setCatalogPreparing] = useState(false);
  const [catalogActionError, setCatalogActionError] = useState<string>();
  const [creationActionError, setCreationActionError] = useState<string>();

  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newGenre, setNewGenre] = useState('');
  const [newArchetype, setNewArchetype] = useState('');
  const [newSummary, setNewSummary] = useState('');

  useEffect(() => {
    const request = createBookMutation.creation.pending?.request;
    if (request) {
      setNewTitle(request.title ?? '');
      setNewGenre(request.genre ?? '');
      setNewArchetype(request.archetype ?? '');
      setNewSummary(request.summary ?? '');
    }
  }, [createBookMutation.creation.pending?.request]);

  // Edit dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editGenre, setEditGenre] = useState('');
  const [editArchetype, setEditArchetype] = useState('');
  const [editSummary, setEditSummary] = useState('');

  // Delete confirmation state
  const [deleteOpen, setDeleteOpen] = useState(false);

  const archetypeOptions = useMemo(
    () => (newGenre ? (GENRE_ARCHETYPES[newGenre] ?? []) : []),
    [newGenre],
  );

  // Find the most recently updated book for resume card
  const resumeBook = useMemo(() => {
    if (books.length === 0) return null;
    return [...books].sort(
      (a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime(),
    )[0];
  }, [books]);

  useEffect(() => {
    if (!resumeBook) return;
    const activeBook = books.find((book) => book.id === activeBookId) ?? null;
    if (activeBook) {
      if (activeBookTitle !== activeBook.title) {
        setActiveBookTitle(activeBook.title);
      }
      return;
    }

    setActiveBookId(resumeBook.id);
    setActiveBookTitle(resumeBook.title);
  }, [activeBookId, activeBookTitle, books, resumeBook, setActiveBookId, setActiveBookTitle]);

  const totalWords = books.reduce((sum, p) => sum + (p.wordCount ?? 0), 0);
  const activeCount = books.filter((p) =>
    ['writing', 'outlining', 'revising'].includes(p.draftStatus ?? ''),
  ).length;
  const completedCount = books.filter((p) => p.draftStatus === 'complete').length;

  function handleGenreChange(genre: string) {
    setNewGenre(genre);
    setNewArchetype('');
  }

  function resetForm() {
    setNewTitle('');
    setNewGenre('');
    setNewArchetype('');
    setNewSummary('');
  }

  async function handleCreateProject(e: React.FormEvent) {
    e.preventDefault();
    if (
      !newTitle.trim() ||
      createBookMutation.creation.pending ||
      !createBookMutation.creation.ready ||
      createBookMutation.isPending
    )
      return;
    createBookMutation.mutate(
      {
        title: newTitle.trim(),
        genre: newGenre || undefined,
        archetype: newArchetype || undefined,
        summary: newSummary.trim() || undefined,
      },
      {
        onSuccess: () => {
          setCreateOpen(false);
          resetForm();
        },
      },
    );
  }

  const currentTarget = (target: NonNullable<typeof dialogTarget.current>) =>
    dialogTarget.current === target &&
    target.epoch === preparationEpoch.current &&
    target.userId === userId;
  const beginCatalogDialog = (project: Book, kind: 'edit' | 'delete') => {
    const target = { epoch: ++preparationEpoch.current, userId, bookId: project.id, kind };
    dialogTarget.current = target;
    setEditSnapshot(undefined);
    setDeleteSnapshot(undefined);
    setEditTitle('');
    setEditGenre('');
    setEditArchetype('');
    setEditSummary('');
    setEditOpen(kind === 'edit');
    setDeleteOpen(kind === 'delete');
    setCatalogPreparing(true);
    setCatalogActionError(undefined);
    return target;
  };
  async function openEditDialog(project: Book) {
    const target = beginCatalogDialog(project, 'edit');
    try {
      const snapshot = await catalog.prepare(project.id);
      if (!currentTarget(target)) return;
      if (
        snapshot.userId !== userId ||
        snapshot.bookId !== target.bookId ||
        snapshot.book.id !== target.bookId
      )
        throw new Error('Prepared project source does not match the selected project.');
      setEditSnapshot(snapshot);
      setEditTitle(snapshot.book.title);
      setEditGenre(snapshot.book.genre ?? '');
      setEditArchetype(snapshot.book.archetype ?? '');
      setEditSummary(snapshot.book.summary ?? '');
    } catch (error) {
      if (currentTarget(target))
        setCatalogActionError(
          error instanceof Error ? error.message : 'Unable to prepare project editing.',
        );
    } finally {
      if (currentTarget(target)) setCatalogPreparing(false);
    }
  }

  function handleEditGenreChange(genre: string) {
    setEditGenre(genre);
    setEditArchetype('');
  }

  const editArchetypeOptions = useMemo(
    () => (editGenre ? (GENRE_ARCHETYPES[editGenre] ?? []) : []),
    [editGenre],
  );

  const activeEditSnapshot =
    editOpen &&
    dialogTarget.current?.kind === 'edit' &&
    editSnapshot?.userId === userId &&
    editSnapshot.bookId === dialogTarget.current.bookId
      ? editSnapshot
      : undefined;
  const activeDeleteSnapshot =
    deleteOpen &&
    dialogTarget.current?.kind === 'delete' &&
    deleteSnapshot?.userId === userId &&
    deleteSnapshot.bookId === dialogTarget.current.bookId
      ? deleteSnapshot
      : undefined;
  const refreshProjects = () => queryClient.invalidateQueries({ queryKey: bookKeys.list(userId) });
  const closeCatalogDialogs = () => {
    preparationEpoch.current += 1;
    dialogTarget.current = undefined;
    setCatalogPreparing(false);
    setEditOpen(false);
    setDeleteOpen(false);
    setEditSnapshot(undefined);
    setDeleteSnapshot(undefined);
  };
  async function handleEditProject(e: React.FormEvent) {
    e.preventDefault();
    const target = dialogTarget.current;
    if (!activeEditSnapshot || !target || !editTitle.trim() || catalog.busy || catalog.pending)
      return;
    setCatalogActionError(undefined);
    try {
      await catalog.update(activeEditSnapshot, {
        title: editTitle.trim(),
        genre: editGenre || undefined,
        archetype: editArchetype || undefined,
        summary: editSummary !== (activeEditSnapshot.book.summary ?? '') ? editSummary : undefined,
      });
      await refreshProjects();
      if (currentTarget(target)) closeCatalogDialogs();
    } catch (error) {
      if (currentTarget(target))
        setCatalogActionError(error instanceof Error ? error.message : 'Unable to update project.');
    }
  }
  async function openDeleteDialog(project: Book) {
    const target = beginCatalogDialog(project, 'delete');
    try {
      const snapshot = await catalog.prepare(project.id);
      if (!currentTarget(target)) return;
      if (
        snapshot.userId !== userId ||
        snapshot.bookId !== target.bookId ||
        snapshot.book.id !== target.bookId
      )
        throw new Error('Prepared project source does not match the selected project.');
      setDeleteSnapshot(snapshot);
    } catch (error) {
      if (currentTarget(target))
        setCatalogActionError(
          error instanceof Error ? error.message : 'Unable to prepare project deletion.',
        );
    } finally {
      if (currentTarget(target)) setCatalogPreparing(false);
    }
  }
  async function handleDeleteProject() {
    const target = dialogTarget.current;
    if (!activeDeleteSnapshot || !target || catalog.busy || catalog.pending) return;
    setCatalogActionError(undefined);
    try {
      await catalog.remove(activeDeleteSnapshot);
      await refreshProjects();
      if (currentTarget(target)) closeCatalogDialogs();
    } catch (error) {
      if (currentTarget(target))
        setCatalogActionError(error instanceof Error ? error.message : 'Unable to delete project.');
    }
  }
  async function recoverCreation(retry = false) {
    setCreationActionError(undefined);
    try {
      const result = retry
        ? await createBookMutation.retryCreation()
        : await createBookMutation.recoverCreation();
      if (result) {
        setCreateOpen(false);
        resetForm();
      }
    } catch (error) {
      setCreationActionError(
        error instanceof Error ? error.message : 'Unable to recover project creation.',
      );
    }
  }
  async function recoverCatalog(retry = false) {
    setCatalogActionError(undefined);
    try {
      const result = retry ? await catalog.retry() : await catalog.recover();
      if (result) {
        await refreshProjects();
        closeCatalogDialogs();
      }
    } catch (error) {
      setCatalogActionError(
        error instanceof Error ? error.message : 'Unable to recover project change.',
      );
    }
  }
  const retryCreationStorage = !createBookMutation.creation.ready &&
    createBookMutation.creation.error && (
      <Button
        type="button"
        onClick={() => {
          setCreationActionError(undefined);
          void createBookMutation.creation.session
            ?.load()
            .catch((error: unknown) =>
              setCreationActionError(
                error instanceof Error ? error.message : 'Unable to reopen project recovery.',
              ),
            );
        }}
      >
        Retry project recovery storage
      </Button>
    );
  const creationRecovery = createBookMutation.creation.pending && (
    <aside
      aria-label="Project creation recovery"
      className="space-y-2 rounded border border-border-muted p-3"
    >
      <p>Pending project: {createBookMutation.creation.pending.request.title}</p>
      <p className="whitespace-pre-wrap">{createBookMutation.creation.pending.request.summary}</p>
      <p className="break-all">Operation: {createBookMutation.creation.pending.operationId}</p>
      <Button
        type="button"
        disabled={createBookMutation.creation.busy}
        onClick={() => void recoverCreation()}
      >
        Recover original project creation
      </Button>
      {createBookMutation.creation.retryAllowed && (
        <Button
          type="button"
          disabled={createBookMutation.creation.busy}
          onClick={() => void recoverCreation(true)}
        >
          Retry original project creation
        </Button>
      )}
      {createBookMutation.creation.pending.state === 'rejected' && (
        <Button
          type="button"
          disabled={createBookMutation.creation.busy}
          onClick={() => {
            void createBookMutation.creation.session
              ?.discardRejected()
              .then(() => {
                setCreateOpen(false);
                resetForm();
              })
              .catch((error: unknown) =>
                setCreationActionError(
                  error instanceof Error ? error.message : 'Unable to discard rejected request.',
                ),
              );
          }}
        >
          Discard rejected project creation
        </Button>
      )}
    </aside>
  );
  const catalogRecovery = catalog.pending && (
    <aside
      aria-label="Project change recovery"
      className="space-y-2 rounded border border-border-muted p-3"
    >
      <p>Pending project change: {catalog.pending.snapshot.book.title}</p>
      <p className="break-all">Operation: {catalog.pending.operationId}</p>
      <pre className="whitespace-pre-wrap break-words">
        {JSON.stringify(catalog.pending.patch ?? { kind: catalog.pending.kind }, null, 2)}
      </pre>
      <Button type="button" disabled={catalog.busy} onClick={() => void recoverCatalog()}>
        Recover original project change
      </Button>
      {catalog.retryAllowed && (
        <Button type="button" disabled={catalog.busy} onClick={() => void recoverCatalog(true)}>
          Retry original project change
        </Button>
      )}
      {catalog.pending.status === 'rejected' && (
        <Button
          type="button"
          disabled={catalog.busy}
          onClick={() => {
            void catalog
              .discardRejected()
              .then(() => {
                closeCatalogDialogs();
                void refreshProjects();
              })
              .catch((error: unknown) =>
                setCatalogActionError(
                  error instanceof Error ? error.message : 'Unable to discard rejected request.',
                ),
              );
          }}
        >
          Discard rejected project change
        </Button>
      )}
    </aside>
  );

  return (
    <PageTransition>
      <div className="space-y-8">
        {!createOpen && creationRecovery}
        {!createOpen && retryCreationStorage}
        {!editOpen && !deleteOpen && catalogRecovery}
        {!createOpen && (creationActionError || createBookMutation.creation.error) && (
          <p role="alert">{creationActionError || createBookMutation.creation.error}</p>
        )}
        {!editOpen &&
          !deleteOpen &&
          (catalogActionError || catalog.error || catalog.journalError) && (
            <p role="alert">{catalogActionError || catalog.error || catalog.journalError}</p>
          )}
        {/* ── Header ─────────────────────────── */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="font-[--font-display] text-[length:--text-3xl] font-bold tracking-tight text-text-primary">
              Dashboard
            </h1>
            <p className="mt-1 text-[length:--text-sm] text-text-secondary">
              Your writing projects at a glance.
            </p>
          </div>

          <Dialog
            open={createOpen}
            onOpenChange={(open) => {
              setCreateOpen(open);
              if (!open && !createBookMutation.creation.pending) resetForm();
            }}
          >
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 size-4" />
                New Project
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[85dvh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>Create New Project</DialogTitle>
                <DialogDescription>
                  Set up your next story. You can always change these later.
                </DialogDescription>
              </DialogHeader>
              <form className="space-y-4 mt-4" onSubmit={handleCreateProject}>
                <fieldset
                  disabled={
                    createBookMutation.isPending ||
                    createBookMutation.creation.busy ||
                    !!createBookMutation.creation.pending ||
                    !createBookMutation.creation.ready
                  }
                  className="space-y-4"
                >
                  <div>
                    <label
                      htmlFor="new-project-title"
                      className="text-[length:--text-sm] font-medium text-text-primary"
                    >
                      Title
                    </label>
                    <Input
                      id="new-project-title"
                      className="mt-1.5 text-[16px]"
                      placeholder="Working title..."
                      value={newTitle}
                      onChange={(e) => setNewTitle(e.target.value)}
                      required
                    />
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label className="text-[length:--text-sm] font-medium text-text-primary">
                        Genre
                      </label>
                      <Select value={newGenre} onValueChange={handleGenreChange}>
                        <SelectTrigger className="mt-1.5">
                          <SelectValue placeholder="Choose genre" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="fantasy">Fantasy</SelectItem>
                          <SelectItem value="sci-fi">Sci-Fi</SelectItem>
                          <SelectItem value="thriller">Thriller</SelectItem>
                          <SelectItem value="romance">Romance</SelectItem>
                          <SelectItem value="literary">Literary Fiction</SelectItem>
                          <SelectItem value="mystery">Mystery</SelectItem>
                          <SelectItem value="horror">Horror</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label className="text-[length:--text-sm] font-medium text-text-primary">
                        Archetype
                      </label>
                      <Select
                        value={newArchetype}
                        onValueChange={setNewArchetype}
                        disabled={!newGenre}
                      >
                        <SelectTrigger className="mt-1.5">
                          <SelectValue
                            placeholder={newGenre ? 'Choose archetype' : 'Select genre first'}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {archetypeOptions.map((arch) => (
                            <SelectItem key={arch.id} value={arch.id}>
                              {arch.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div>
                    <label
                      htmlFor="new-project-summary"
                      className="text-[length:--text-sm] font-medium text-text-primary"
                    >
                      Summary
                    </label>
                    <Textarea
                      id="new-project-summary"
                      className="mt-1.5 text-[16px]"
                      placeholder="A brief premise for your story..."
                      rows={3}
                      value={newSummary}
                      onChange={(e) => setNewSummary(e.target.value)}
                    />
                  </div>
                </fieldset>
                {creationRecovery}
                {retryCreationStorage}
                {(creationActionError || createBookMutation.creation.error) && (
                  <p role="alert">{creationActionError || createBookMutation.creation.error}</p>
                )}
                {createBookMutation.error && (
                  <p className="text-[length:--text-sm] text-red-400">
                    {createBookMutation.error.message}
                  </p>
                )}
                <div className="flex justify-end gap-3 pt-2">
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={() => {
                      setCreateOpen(false);
                      if (!createBookMutation.creation.pending) resetForm();
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={
                      createBookMutation.isPending ||
                      createBookMutation.creation.busy ||
                      !!createBookMutation.creation.pending ||
                      !createBookMutation.creation.ready ||
                      !newTitle.trim()
                    }
                  >
                    {createBookMutation.isPending ? (
                      <Loader2 className="mr-2 size-4 animate-spin" />
                    ) : (
                      <Sparkles className="mr-2 size-4" />
                    )}
                    {createBookMutation.isPending ? 'Creating…' : 'Create & Begin'}
                  </Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        {/* ── Resume Writing Card ─────────────── */}
        {resumeBook && (
          <FadeIn>
            <Card className="border-accent-500/30 bg-linear-to-r from-accent-500/5 to-transparent">
              <CardContent className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center">
                <div className="flex-1 min-w-0">
                  <p className="text-[length:--text-xs] font-medium uppercase tracking-wider text-accent-400">
                    Resume Writing
                  </p>
                  <h3 className="mt-1 text-[length:--text-lg] font-semibold text-text-primary truncate">
                    {resumeBook.title}
                  </h3>
                  <div className="mt-1 flex items-center gap-3 text-[length:--text-sm] text-text-secondary">
                    <span>{(resumeBook.wordCount ?? 0).toLocaleString()} words</span>
                    <span>•</span>
                    <span>{formatRelativeTime(resumeBook.updatedAt ?? '')}</span>
                  </div>
                </div>
                <Link href={`/manuscript?bookId=${resumeBook.id}`}>
                  <Button className="shrink-0">
                    <PenTool className="mr-2 size-4" />
                    Continue Writing
                    <ArrowRight className="ml-2 size-4" />
                  </Button>
                </Link>
              </CardContent>
            </Card>
          </FadeIn>
        )}

        {/* ── Stats Row ──────────────────────── */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatCard
            label="Total Words"
            value={<AnimatedNumber value={totalWords} format={(n) => n.toLocaleString()} />}
          />
          <StatCard label="Active Projects" value={<AnimatedNumber value={activeCount} />} />
          <StatCard label="Completed" value={<AnimatedNumber value={completedCount} />} />
        </div>

        {/* ── Project Cards ──────────────────── */}
        <section>
          <h2 className="mb-4 text-[length:--text-lg] font-semibold text-text-primary">Projects</h2>

          <AsyncBoundary
            isLoading={isLoading}
            error={error}
            isEmpty={books.length === 0}
            emptyTitle="No projects yet"
            emptyDescription="Create your first project to start writing."
            emptyIcon={<BookOpen className="size-6" />}
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {books.map((project) => (
                <Link
                  key={project.id}
                  href={`/manuscript?bookId=${project.id}`}
                  className="block"
                  onClick={() => {
                    setActiveBookId(project.id);
                    setActiveBookTitle(project.title);
                  }}
                >
                  <Card className="group relative transition-all duration-[--duration-normal] hover:border-border-strong hover:shadow-lg h-full">
                    <CardHeader className="flex-row items-start justify-between space-y-0">
                      <div className="flex-1 min-w-0">
                        <CardTitle className="truncate">{project.title}</CardTitle>
                        <div className="mt-1.5 flex items-center gap-2">
                          <Badge variant={statusColors[project.draftStatus ?? 'draft']}>
                            {project.draftStatus ?? 'draft'}
                          </Badge>
                          {project.archetype && (
                            <span className="text-[length:--text-xs] text-text-muted">
                              {project.archetype}
                            </span>
                          )}
                        </div>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            onClick={(e) => e.preventDefault()}
                            className="flex size-11 shrink-0 items-center justify-center rounded-[--radius-sm] text-text-muted hover:text-text-primary opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity cursor-pointer"
                            aria-label={`Project options for ${project.title}`}
                          >
                            <MoreVertical className="size-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link href={`/manuscript?bookId=${project.id}`}>Open</Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={(e) => e.stopPropagation()}
                            onSelect={() => void openEditDialog(project)}
                          >
                            <Pencil className="mr-2 size-3.5" /> Edit Details
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link href="/publish">Export</Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-red-400 focus:text-red-300"
                            onClick={(e) => e.stopPropagation()}
                            onSelect={() => void openDeleteDialog(project)}
                          >
                            <Trash2 className="mr-2 size-3.5" /> Delete Project
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </CardHeader>
                    <CardContent>
                      <div className="flex items-center gap-4 text-[length:--text-xs] text-text-muted">
                        <ProgressRing
                          value={Math.min(100, ((project.wordCount ?? 0) / 80000) * 100)}
                          size={32}
                          strokeWidth={3}
                          color={
                            project.draftStatus === 'complete'
                              ? 'var(--color-success-400)'
                              : 'var(--color-accent-400)'
                          }
                        >
                          <span className="text-[8px] font-bold text-text-primary">
                            {Math.round(Math.min(100, ((project.wordCount ?? 0) / 80000) * 100))}%
                          </span>
                        </ProgressRing>
                        <span className="flex items-center gap-1">
                          <FileText className="size-3.5" />
                          {(project.wordCount ?? 0).toLocaleString()} words
                        </span>
                        {project.genre && (
                          <span className="flex items-center gap-1">
                            <Feather className="size-3.5" />
                            {project.genre}
                          </span>
                        )}
                        {project.updatedAt && (
                          <span className="ml-auto flex items-center gap-1">
                            <Clock className="size-3.5" />
                            {formatRelativeTime(project.updatedAt)}
                          </span>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </AsyncBoundary>
        </section>

        {/* ── Edit Project Dialog ────────────── */}
        <Dialog
          open={editOpen}
          onOpenChange={(open) => {
            if (!open) closeCatalogDialogs();
          }}
        >
          <DialogContent className="max-h-[85dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Edit Project</DialogTitle>
              <DialogDescription>Update your project details.</DialogDescription>
            </DialogHeader>
            <form className="space-y-4 mt-4" onSubmit={handleEditProject}>
              <fieldset
                disabled={
                  catalogPreparing || catalog.busy || !!catalog.pending || !activeEditSnapshot
                }
                className="space-y-4"
              >
                <div>
                  <label
                    htmlFor="edit-project-title"
                    className="text-[length:--text-sm] font-medium text-text-primary"
                  >
                    Title
                  </label>
                  <Input
                    id="edit-project-title"
                    className="mt-1.5 text-[16px]"
                    placeholder="Working title..."
                    value={activeEditSnapshot ? editTitle : ''}
                    onChange={(e) => setEditTitle(e.target.value)}
                    required
                  />
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className="text-[length:--text-sm] font-medium text-text-primary">
                      Genre
                    </label>
                    <Select
                      value={activeEditSnapshot ? editGenre : ''}
                      onValueChange={handleEditGenreChange}
                    >
                      <SelectTrigger className="mt-1.5">
                        <SelectValue placeholder="Choose genre" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="fantasy">Fantasy</SelectItem>
                        <SelectItem value="sci-fi">Sci-Fi</SelectItem>
                        <SelectItem value="thriller">Thriller</SelectItem>
                        <SelectItem value="romance">Romance</SelectItem>
                        <SelectItem value="literary">Literary Fiction</SelectItem>
                        <SelectItem value="mystery">Mystery</SelectItem>
                        <SelectItem value="horror">Horror</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="text-[length:--text-sm] font-medium text-text-primary">
                      Archetype
                    </label>
                    <Select
                      value={activeEditSnapshot ? editArchetype : ''}
                      onValueChange={setEditArchetype}
                      disabled={!editGenre}
                    >
                      <SelectTrigger className="mt-1.5">
                        <SelectValue
                          placeholder={editGenre ? 'Choose archetype' : 'Select genre first'}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {editArchetypeOptions.map((arch) => (
                          <SelectItem key={arch.id} value={arch.id}>
                            {arch.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <label
                    htmlFor="edit-project-summary"
                    className="text-[length:--text-sm] font-medium text-text-primary"
                  >
                    Summary
                  </label>
                  <Textarea
                    id="edit-project-summary"
                    className="mt-1.5 text-[16px]"
                    placeholder="A brief premise for your story..."
                    rows={3}
                    value={activeEditSnapshot ? editSummary : ''}
                    onChange={(e) => setEditSummary(e.target.value)}
                  />
                </div>
              </fieldset>
              {catalogRecovery}
              {(catalogActionError || catalog.error || catalog.journalError) && (
                <p role="alert">{catalogActionError || catalog.error || catalog.journalError}</p>
              )}
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="secondary" type="button" onClick={closeCatalogDialogs}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={
                    catalogPreparing ||
                    catalog.busy ||
                    !!catalog.pending ||
                    !activeEditSnapshot ||
                    !editTitle.trim()
                  }
                >
                  {catalog.busy ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : (
                    <Pencil className="mr-2 size-4" />
                  )}
                  {catalog.busy ? 'Saving…' : 'Save Changes'}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>

        {/* ── Delete Confirmation Dialog ─────── */}
        <Dialog
          open={deleteOpen}
          onOpenChange={(open) => {
            if (!open) closeCatalogDialogs();
          }}
        >
          <DialogContent className="max-h-[85dvh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Delete Project</DialogTitle>
              <DialogDescription>
                Are you sure you want to delete{' '}
                <strong>
                  {activeDeleteSnapshot?.book.title ?? 'the selected project (source loading)'}
                </strong>
                ? This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            {catalogRecovery}
            {(catalogActionError || catalog.error || catalog.journalError) && (
              <p role="alert">{catalogActionError || catalog.error || catalog.journalError}</p>
            )}
            <div className="flex justify-end gap-3 pt-4">
              <Button variant="secondary" onClick={closeCatalogDialogs}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={handleDeleteProject}
                disabled={
                  catalogPreparing || catalog.busy || !!catalog.pending || !activeDeleteSnapshot
                }
              >
                {catalog.busy ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <Trash2 className="mr-2 size-4" />
                )}
                {catalog.busy ? 'Deleting…' : 'Delete Project'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </PageTransition>
  );
}
