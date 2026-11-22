'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft, Check, Loader2, Plus, SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';

import { PageTransition } from '@/components/motion/primitives';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Textarea } from '@/components/ui/input';
import { useWorkspace } from '@/contexts/workspace-context';
import {
  activateEditorialProfile,
  createEditorialProfile,
  listEditorialProfiles,
  resolveEditorialProfile,
  type EditorialProfile,
} from '@/lib/api';

export default function EditorialProfilesPage() {
  const { activeBookId } = useWorkspace();
  const [profiles, setProfiles] = React.useState<EditorialProfile[]>([]);
  const [resolved, setResolved] = React.useState<Awaited<
    ReturnType<typeof resolveEditorialProfile>
  > | null>(null);
  const [name, setName] = React.useState('');
  const [goals, setGoals] = React.useState('clarity, specificity, voice fidelity');
  const [preserve, setPreserve] = React.useState('canon, intent, POV, tense');
  const [avoid, setAvoid] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(async () => {
    const list = await listEditorialProfiles();
    setProfiles(list);
    setResolved(activeBookId ? await resolveEditorialProfile(activeBookId) : null);
  }, [activeBookId]);

  React.useEffect(() => {
    void refresh().catch((error) =>
      toast.error(error instanceof Error ? error.message : 'Profiles failed'),
    );
  }, [refresh]);

  async function create() {
    if (name.trim().length < 2) return toast.error('Give the profile a name.');
    setBusy(true);
    try {
      await createEditorialProfile({
        name: name.trim(),
        bookId: activeBookId ? Number(activeBookId) : undefined,
        active: Boolean(activeBookId),
        config: {
          styleGoals: goals
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
          mustPreserve: preserve
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
          mustAvoid: avoid
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
        },
      });
      setName('');
      await refresh();
      toast.success('Immutable profile version created.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Profile creation failed');
    } finally {
      setBusy(false);
    }
  }

  async function activate(profile: EditorialProfile) {
    if (!activeBookId) return toast.error('Choose a book before activating a profile.');
    try {
      await activateEditorialProfile(activeBookId, profile.id);
      await refresh();
      toast.success(`${profile.name} is active for this book.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Activation failed');
    }
  }

  return (
    <PageTransition className="mx-auto w-full max-w-6xl space-y-7 px-5 py-7 lg:px-9">
      <Link
        href="/editorial"
        className="inline-flex items-center gap-2 text-sm text-text-muted hover:text-accent-300"
      >
        <ArrowLeft className="size-4" /> Editorial
      </Link>
      <header className="border-l border-accent-500 pl-5">
        <p className="font-[--font-mono] text-[10px] uppercase tracking-[0.22em] text-accent-400">
          Editorial constitution
        </p>
        <h1 className="mt-2 font-[--font-display] text-4xl">Profiles</h1>
        <p className="mt-2 max-w-2xl text-text-secondary">
          Versioned constraints shape candidate generation and judging. Preference evidence is
          bounded and never silently rewrites a profile.
        </p>
      </header>

      {resolved && (
        <Card className="border-accent-600/40">
          <CardContent className="flex items-center gap-4 p-5">
            <Check className="size-5 text-success" />
            <div className="flex-1">
              <p className="font-medium">
                {resolved.name} <span className="text-text-muted">v{resolved.version}</span>
              </p>
              <p className="font-[--font-mono] text-[10px] text-text-muted">
                {resolved.hash.slice(0, 16)} · resolved for active book
              </p>
            </div>
            <Badge variant="success">active</Badge>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Plus className="size-5 text-accent-400" /> New profile version
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Profile name"
            />
            <label className="block space-y-2">
              <span className="text-sm text-text-secondary">Style goals</span>
              <Textarea value={goals} onChange={(event) => setGoals(event.target.value)} rows={3} />
            </label>
            <label className="block space-y-2">
              <span className="text-sm text-text-secondary">Must preserve</span>
              <Textarea
                value={preserve}
                onChange={(event) => setPreserve(event.target.value)}
                rows={3}
              />
            </label>
            <label className="block space-y-2">
              <span className="text-sm text-text-secondary">Must avoid</span>
              <Textarea
                value={avoid}
                onChange={(event) => setAvoid(event.target.value)}
                rows={3}
                placeholder="Comma-separated, optional"
              />
            </label>
            <Button onClick={() => void create()} disabled={busy}>
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <SlidersHorizontal className="size-4" />
              )}{' '}
              Save version
            </Button>
          </CardContent>
        </Card>

        <section className="space-y-3">
          {profiles.map((profile) => (
            <Card key={profile.id}>
              <CardContent className="flex items-start gap-4 p-5">
                <span className="mt-1 h-10 w-1 rounded-full bg-accent-600/70" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {profile.name} <span className="text-text-muted">v{profile.version}</span>
                  </p>
                  <p className="mt-1 font-[--font-mono] text-[10px] text-text-muted">
                    {profile.configHash.slice(0, 16)} ·{' '}
                    {profile.bookId ? `book ${profile.bookId}` : 'global'}
                  </p>
                  <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs leading-5 text-text-secondary">
                    {JSON.stringify(profile.config, null, 2)}
                  </pre>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!activeBookId || resolved?.id === profile.id}
                  onClick={() => void activate(profile)}
                >
                  {resolved?.id === profile.id ? 'Active' : 'Activate'}
                </Button>
              </CardContent>
            </Card>
          ))}
          {!profiles.length && (
            <Card>
              <CardContent className="p-6 text-text-secondary">
                The built-in Balanced profile is currently resolved. Create a durable custom version
                when the book needs explicit constraints.
              </CardContent>
            </Card>
          )}
        </section>
      </div>
    </PageTransition>
  );
}
