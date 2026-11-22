'use client';

import { useEffect, useMemo, useState } from 'react';
import { useProtectedRouter as useRouter } from '@/hooks/use-protected-router';
import { useSession } from 'next-auth/react';
import { useDocumentQuickDraft, type QuickDraftTarget } from '@/hooks/use-document-quick-draft';
import { getAuthoringDocumentCapabilities } from '@/lib/document-api';
import { getDocumentNavigation } from '@/lib/document-navigation';
import { ArrowRight, BookOpen, Loader2, Plus, Sparkles, WandSparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useBooks } from '@/hooks/queries/use-books';
import { useWorkspace } from '@/contexts/workspace-context';
import { useMobileState } from '@/contexts/mobile-state-context';
import { getLatestSceneTrace, getStructure, type ActRecord, type SceneRecord } from '@/lib/api';

const EMPTY_ACTS: ActRecord[] = [];

function buildQuickDraftOutline(premise: string, tone: string) {
  return [
    premise.trim() ? `Premise: ${premise.trim()}` : '',
    tone.trim() ? `Tone: ${tone.trim()}` : '',
    'Draft a strong scene opening that is easy to revise with natural-language commands.',
  ]
    .filter(Boolean)
    .join('\n');
}

function findFirstScene(acts: ActRecord[]): SceneRecord | null {
  for (const act of acts) {
    for (const chapter of act.chapters) {
      const scene = chapter.scenes[0];
      if (scene) return scene;
    }
  }
  return null;
}

function findSceneById(acts: ActRecord[], sceneId: string | null): SceneRecord | null {
  if (!sceneId) return null;
  for (const act of acts) {
    for (const chapter of act.chapters) {
      const scene = chapter.scenes.find((candidate) => candidate.id === sceneId);
      if (scene) return scene;
    }
  }
  return null;
}

function sceneStatusLabel(status: string | null) {
  if (status === 'ready' || status === 'completed') return 'Ready to revise';
  if (status === 'pending' || status === 'submitted' || status === 'streaming')
    return 'Generation in progress';
  return 'Ready to continue';
}

export default function MobileHomePage() {
  const { data: session } = useSession();
  const userId = session?.user?.id;
  if (!userId) return <p role="status">Authenticate to open your mobile workspace.</p>;
  return <MobileHomeContent key={userId} userId={userId} />;
}

function MobileHomeContent({ userId }: { userId: string }) {
  const router = useRouter();
  const quickDraft = useDocumentQuickDraft(userId);
  const { data: books = [], isLoading: booksLoading } = useBooks();
  const {
    activeBookId,
    activeSceneId,
    setActiveBookId,
    setActiveBookTitle,
    setActiveSceneId,
    setActiveSurface,
  } = useWorkspace();
  const { lastBookId, lastSceneId, setLastDraftTarget, setDraftBrief, setPendingCommand } =
    useMobileState();

  const [resumeNavigation, setResumeNavigation] = useState<{ scope: string; acts: ActRecord[] }>();
  const [resumeError, setResumeError] = useState<{ scope: string; message: string }>();
  const [resumeStatus, setResumeStatus] = useState<string | null>(null);
  const [quickDraftOpen, setQuickDraftOpen] = useState(false);
  const [quickDraftMode, setQuickDraftMode] = useState<'existing' | 'new'>('existing');
  const [existingBookId, setExistingBookId] = useState<string>('');
  const [newBookTitle, setNewBookTitle] = useState('');
  const [genre, setGenre] = useState('');
  const [premise, setPremise] = useState('');
  const [tone, setTone] = useState('');
  const [creatingDraft, setCreatingDraft] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  const resumeBookId = useMemo(
    () => lastBookId ?? activeBookId ?? books[0]?.id ?? null,
    [activeBookId, books, lastBookId],
  );
  const resumeBook = books.find((book) => book.id === resumeBookId) ?? null;
  const resumeScope = `${userId}:${resumeBookId ?? ''}`;
  const resumeActs = resumeNavigation?.scope === resumeScope ? resumeNavigation.acts : EMPTY_ACTS;
  const resumeScene = useMemo(
    () => findSceneById(resumeActs, lastSceneId ?? activeSceneId) ?? findFirstScene(resumeActs),
    [activeSceneId, lastSceneId, resumeActs],
  );

  useEffect(() => {
    if (!resumeBookId || !userId) return;
    let active = true;
    setResumeError(undefined);
    void (async () => {
      const capabilities = await getAuthoringDocumentCapabilities();
      if (capabilities.enabled) {
        if (capabilities.schemaVersion !== 1)
          throw new Error('Factory advertises an unsupported document schema.');
        return getDocumentNavigation(resumeBookId);
      }
      return (await getStructure(resumeBookId)).data.acts;
    })()
      .then((acts) => {
        if (!active) return;
        setResumeNavigation({ scope: resumeScope, acts });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setResumeNavigation(undefined);
        setResumeError({
          scope: resumeScope,
          message: error instanceof Error ? error.message : 'Unable to load saved navigation.',
        });
      });

    return () => {
      active = false;
    };
  }, [resumeBookId, resumeScope, userId]);

  useEffect(() => {
    if (!resumeBookId || !resumeScene) {
      setResumeStatus(null);
      return;
    }
    let active = true;
    void getLatestSceneTrace(resumeBookId, resumeScene.id)
      .then((response) => {
        if (!active) return;
        setResumeStatus(response.data?.status ?? null);
      })
      .catch(() => {
        if (!active) return;
        setResumeStatus(null);
      });

    return () => {
      active = false;
    };
  }, [resumeBookId, resumeScene]);

  useEffect(() => {
    if (books.length > 0 && !existingBookId) {
      setExistingBookId(resumeBookId ?? books[0]?.id ?? '');
    }
  }, [books, existingBookId, resumeBookId]);

  function openStudio(bookId: string, sceneId: string, bookTitle?: string | null) {
    setActiveBookId(bookId);
    setActiveSceneId(sceneId);
    setActiveSurface('manuscript');
    if (bookTitle) {
      setActiveBookTitle(bookTitle);
    }
    setLastDraftTarget(bookId, sceneId);
    router.push(
      `/m/studio?bookId=${encodeURIComponent(bookId)}&sceneId=${encodeURIComponent(sceneId)}`,
    );
  }

  async function handleQuickDraftSubmit(e: React.FormEvent) {
    e.preventDefault();
    setCreatingDraft(true);
    setDraftError(null);

    try {
      const premiseText = premise.trim();
      const toneText = tone.trim();
      const draftOutline = buildQuickDraftOutline(premiseText, toneText);
      const sceneTitle = (premiseText.split(/[.!?]/)[0] ?? '').trim().slice(0, 80) || 'Quick Draft';
      const capabilities = await getAuthoringDocumentCapabilities();
      if (capabilities.enabled) {
        if (capabilities.schemaVersion !== 1)
          throw new Error('Factory advertises an unsupported document schema.');
        const target = await quickDraft.create({
          ...(quickDraftMode === 'new'
            ? {
                newBook: {
                  title: newBookTitle.trim() || sceneTitle,
                  genre: genre.trim() || undefined,
                  summary: premiseText || undefined,
                },
              }
            : {
                bookId: existingBookId,
                bookTitle: books.find((book) => book.id === existingBookId)?.title,
              }),
          summary: sceneTitle,
          outline: draftOutline,
        });
        finishQuickDraft(target);
        return;
      }

      throw new Error(
        'Structured document authority is unavailable. Quick Draft requires a compatible Factory.',
      );
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : 'Unable to create the quick draft.');
    } finally {
      setCreatingDraft(false);
    }
  }

  function finishQuickDraft(target: QuickDraftTarget) {
    setDraftBrief(target.outline);
    setPendingCommand('');
    setQuickDraftOpen(false);
    setPremise('');
    setTone('');
    setNewBookTitle('');
    openStudio(target.bookId, target.sceneId, target.bookTitle);
  }
  async function recoverQuickDraft(retry = false) {
    setCreatingDraft(true);
    setDraftError(null);
    try {
      const target = retry ? await quickDraft.retry() : await quickDraft.recover();
      if (target) finishQuickDraft(target);
      else setDraftError('Book creation is acknowledged. Continue the original draft operation.');
    } catch (error) {
      setDraftError(
        error instanceof Error ? error.message : 'Unable to recover the original draft.',
      );
    } finally {
      setCreatingDraft(false);
    }
  }

  return (
    <div className="space-y-4">
      {quickDraft.journalError && <p role="alert">{quickDraft.journalError}</p>}
      {quickDraft.pending && !quickDraftOpen && (
        <aside aria-label="Quick draft recovery" className="rounded border border-border-muted p-3">
          <p>A pending quick draft is available for this author.</p>
          <Button type="button" onClick={() => setQuickDraftOpen(true)}>
            Recover pending quick draft
          </Button>
        </aside>
      )}
      {resumeError?.scope === resumeScope && <p role="alert">{resumeError.message}</p>}
      <section className="space-y-2">
        <p className="text-[length:--text-xs] uppercase tracking-[0.18em] text-text-muted">
          Resume-first
        </p>
        <h1 className="text-[length:--text-3xl] font-semibold">Phone-first drafting</h1>
        <p className="text-[length:--text-sm] text-text-secondary">
          Jump straight into a scene, tell Proser what to write, then revise it with simple
          commands.
        </p>
      </section>

      <Card className="mobile-stagger border-accent-500/20 bg-accent-500/5">
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>{resumeBook?.title ?? 'Start a quick draft'}</CardTitle>
              <CardDescription>
                {resumeScene
                  ? `${resumeScene.summary || resumeScene.outline || 'Untitled scene'}`
                  : 'Create a lightweight drafting scene and open the studio immediately.'}
              </CardDescription>
            </div>
            {resumeStatus && <Badge variant="info">{sceneStatusLabel(resumeStatus)}</Badge>}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Button
              size="lg"
              disabled={!resumeBookId || !resumeScene}
              onClick={() => {
                if (!resumeBookId || !resumeScene) return;
                openStudio(resumeBookId, resumeScene.id, resumeBook?.title ?? null);
              }}
            >
              <ArrowRight className="mr-2 size-4" />
              Continue
            </Button>
            <Button size="lg" variant="secondary" onClick={() => setQuickDraftOpen(true)}>
              <Plus className="mr-2 size-4" />
              Quick Draft
            </Button>
          </div>

          {resumeScene && (
            <div className="rounded-[--radius-lg] border border-border-muted bg-surface-sunken px-4 py-3 text-[length:--text-sm] text-text-secondary">
              <div className="flex items-center justify-between gap-3">
                <span>Current scene</span>
                <span>
                  {resumeScene.wordCount > 0 ? `${resumeScene.wordCount} words` : 'No prose yet'}
                </span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mobile-stagger">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-accent-400" />
            Recent projects
          </CardTitle>
          <CardDescription>
            Pick a project to continue on phone, or branch into a quick mobile draft.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {booksLoading ? (
            <div className="flex items-center gap-2 text-[length:--text-sm] text-text-secondary">
              <Loader2 className="size-4 animate-spin" />
              Loading projects...
            </div>
          ) : books.length === 0 ? (
            <div className="rounded-[--radius-lg] border border-dashed border-border-strong bg-surface-sunken px-4 py-5 text-[length:--text-sm] text-text-secondary">
              No books yet. Create one with Quick Draft.
            </div>
          ) : (
            books.slice(0, 4).map((book) => (
              <button
                key={book.id}
                type="button"
                onClick={() => {
                  setExistingBookId(book.id);
                  setQuickDraftMode('existing');
                  setQuickDraftOpen(true);
                }}
                className="flex w-full items-center justify-between rounded-[--radius-lg] border border-border-muted bg-surface-sunken px-4 py-3 text-left transition-colors hover:border-border-strong hover:bg-surface-hover"
              >
                <div>
                  <p className="font-medium text-text-primary">{book.title}</p>
                  <p className="text-[length:--text-xs] text-text-muted">
                    {book.genre || 'Unspecified genre'}
                  </p>
                </div>
                <WandSparkles className="size-4 text-accent-400" />
              </button>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="mobile-stagger">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BookOpen className="size-4 text-accent-400" />
            Desktop handoff
          </CardTitle>
          <CardDescription>
            Plot, Bible, continuity, and publish flows remain in the full desktop workspace.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-[length:--text-sm] text-text-secondary">
            Use the <strong className="text-text-primary">Desktop</strong> button in the header
            whenever you need the full multi-surface authoring workspace.
          </p>
        </CardContent>
      </Card>

      <Dialog open={quickDraftOpen} onOpenChange={setQuickDraftOpen}>
        <DialogContent className="bottom-0 left-0 top-auto max-h-[85dvh] w-full max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-b-none rounded-t-[--radius-xl] border-x-0 border-b-0 px-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-5 sm:bottom-auto sm:left-[50%] sm:top-[50%] sm:max-w-lg sm:-translate-x-[50%] sm:-translate-y-[50%] sm:rounded-b-[--radius-xl] sm:border-x sm:border-b">
          <DialogHeader>
            <DialogTitle>Quick Draft</DialogTitle>
            <DialogDescription>
              Start from an existing book or create a lightweight project and jump straight into the
              mobile studio.
            </DialogDescription>
          </DialogHeader>

          <form className="mt-4 space-y-4" onSubmit={handleQuickDraftSubmit}>
            <fieldset disabled={creatingDraft || !!quickDraft.pending} className="space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant={quickDraftMode === 'existing' ? 'primary' : 'secondary'}
                  onClick={() => setQuickDraftMode('existing')}
                >
                  Existing Book
                </Button>
                <Button
                  type="button"
                  variant={quickDraftMode === 'new' ? 'primary' : 'secondary'}
                  onClick={() => setQuickDraftMode('new')}
                >
                  New Book
                </Button>
              </div>

              {quickDraftMode === 'existing' ? (
                <div>
                  <label className="mb-2 block text-[length:--text-sm] font-medium text-text-primary">
                    Book
                  </label>
                  <Select value={existingBookId} onValueChange={setExistingBookId}>
                    <SelectTrigger aria-label="Book">
                      <SelectValue placeholder="Choose a book" />
                    </SelectTrigger>
                    <SelectContent>
                      {books.map((book) => (
                        <SelectItem key={book.id} value={book.id}>
                          {book.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div>
                  <label
                    htmlFor="mobile-new-book-title"
                    className="mb-2 block text-[length:--text-sm] font-medium text-text-primary"
                  >
                    Book Title
                  </label>
                  <Input
                    id="mobile-new-book-title"
                    className="text-[16px]"
                    value={newBookTitle}
                    onChange={(event) => setNewBookTitle(event.target.value)}
                    placeholder="Moonlit Kingdom"
                    required
                  />
                </div>
              )}

              <div>
                <label className="mb-2 block text-[length:--text-sm] font-medium text-text-primary">
                  Genre
                </label>
                <Select value={genre} onValueChange={setGenre}>
                  <SelectTrigger aria-label="Genre">
                    <SelectValue placeholder="Optional genre" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fantasy">Fantasy</SelectItem>
                    <SelectItem value="romance">Romance</SelectItem>
                    <SelectItem value="thriller">Thriller</SelectItem>
                    <SelectItem value="horror">Horror</SelectItem>
                    <SelectItem value="mystery">Mystery</SelectItem>
                    <SelectItem value="literary">Literary</SelectItem>
                    <SelectItem value="sci-fi">Sci-Fi</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <label
                  htmlFor="mobile-draft-premise"
                  className="mb-2 block text-[length:--text-sm] font-medium text-text-primary"
                >
                  One-sentence premise
                </label>
                <Textarea
                  id="mobile-draft-premise"
                  className="text-[16px]"
                  rows={3}
                  value={premise}
                  onChange={(event) => setPremise(event.target.value)}
                  placeholder="A disgraced heir sneaks back into the city the night the old wards begin to fail."
                  required
                />
              </div>

              <div>
                <label
                  htmlFor="mobile-draft-tone"
                  className="mb-2 block text-[length:--text-sm] font-medium text-text-primary"
                >
                  Tone
                </label>
                <Input
                  id="mobile-draft-tone"
                  className="text-[16px]"
                  value={tone}
                  onChange={(event) => setTone(event.target.value)}
                  placeholder="Moody, intimate, and urgent"
                />
              </div>
            </fieldset>
            {draftError && (
              <div className="rounded-[--radius-lg] border border-danger/20 bg-danger/10 px-3 py-2 text-[length:--text-sm] text-danger">
                {draftError}
              </div>
            )}
            {quickDraft.pending && (
              <div className="space-y-2">
                <p role="status">Pending quick draft: {quickDraft.pending.operationId}</p>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={creatingDraft}
                  onClick={() => void recoverQuickDraft()}
                >
                  Recover quick draft
                </Button>
                {quickDraft.pending.retryAllowed && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={creatingDraft}
                    onClick={() => void recoverQuickDraft(true)}
                  >
                    Continue original operation
                  </Button>
                )}
                {quickDraft.pending.rejected && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={creatingDraft}
                    onClick={() => {
                      void quickDraft
                        .discardRejected()
                        .then(() =>
                          setDraftError(
                            'The rejected request was discarded. Any acknowledged book creation remains saved.',
                          ),
                        )
                        .catch((error: unknown) =>
                          setDraftError(
                            error instanceof Error
                              ? error.message
                              : 'Unable to discard the rejected request.',
                          ),
                        );
                    }}
                  >
                    Discard rejected draft request
                  </Button>
                )}
              </div>
            )}

            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={creatingDraft || !!quickDraft.pending}
            >
              {creatingDraft ? (
                <Loader2 className="mr-2 size-4 animate-spin" />
              ) : (
                <Sparkles className="mr-2 size-4" />
              )}
              Create And Open Studio
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
