'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { PlotThreadWorkflow } from '@/components/plot/plot-thread-workflow';
import { Search, GitBranch, ChevronRight, Target, Compass } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { EmptyState } from '@/components/ui/data-display';
import { useWorkspace } from '@/contexts/workspace-context';
import { useArchetypes, useBeatCoverage } from '@/hooks/queries/use-plot';
import { AsyncBoundary } from '@/components/ui/async-boundary';
import { PageTransition, FadeIn } from '@/components/motion/primitives';

export default function PlotStudioPage() {
  const { activeBookId } = useWorkspace();
  const [searchTerm, setSearchTerm] = useState('');
  const { data: archetypes = [], isLoading: archetypesLoading } = useArchetypes();
  const { data: beatCoverage } = useBeatCoverage(activeBookId);
  const query = useSearchParams();

  const filteredArchetypes = archetypes.filter(
    (a) =>
      !searchTerm ||
      a.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      a.genreTags?.some((g: string) => g.toLowerCase().includes(searchTerm.toLowerCase())),
  );

  return (
    <PageTransition>
      <div className="space-y-6">
        {/* ── Header ─────────────────────────── */}
        <div>
          <h1 className="font-[--font-display] text-[length:--text-3xl] font-bold tracking-tight text-text-primary">
            Plot Studio
          </h1>
          <p className="mt-1 text-[length:--text-sm] text-text-secondary">
            Shape your story with archetypes, beats, and plot threads.
          </p>
        </div>

        <Tabs
          defaultValue={
            query.get('tab') === 'threads' || query.get('threadId') ? 'threads' : 'archetypes'
          }
        >
          <TabsList className="flex-wrap">
            <TabsTrigger value="archetypes">
              <Compass className="mr-1.5 size-4" />
              Archetypes
            </TabsTrigger>
            <TabsTrigger value="beat-map">
              <Target className="mr-1.5 size-4" />
              Beat Map
            </TabsTrigger>
            <TabsTrigger value="threads">
              <GitBranch className="mr-1.5 size-4" />
              Plot Threads
            </TabsTrigger>
          </TabsList>

          {/* ── Archetypes Tab ───────────────── */}
          <TabsContent value="archetypes" className="mt-6 space-y-4">
            <div className="relative max-w-sm">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-muted" />
              <Input
                placeholder="Search archetypes..."
                className="pl-10"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>

            <AsyncBoundary
              isLoading={archetypesLoading}
              isEmpty={filteredArchetypes.length === 0}
              emptyTitle="No archetypes found"
              emptyDescription="Try a different search term."
            >
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {filteredArchetypes.map((arch) => (
                  <Card
                    key={arch.id}
                    className="group cursor-pointer transition-all duration-[--duration-normal] hover:border-accent-500/40 h-full"
                  >
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div>
                          <CardTitle className="text-[length:--text-base]">{arch.name}</CardTitle>
                          <CardDescription className="mt-1">
                            {arch.description?.slice(0, 80)}…
                          </CardDescription>
                        </div>
                        <ChevronRight className="size-4 text-text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex items-center justify-between text-[length:--text-xs] text-text-muted">
                        <span>{arch.beatCount} beats</span>
                        <div className="flex flex-wrap gap-1">
                          {arch.genreTags?.slice(0, 3).map((tag: string) => (
                            <Badge key={tag} variant="default" className="text-[9px] px-1.5 py-0">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </AsyncBoundary>
          </TabsContent>

          {/* ── Beat Map Tab ─────────────────── */}
          <TabsContent value="beat-map" className="mt-6">
            {!activeBookId ? (
              <EmptyState
                icon={<Target className="size-6" />}
                title="No book selected"
                description="Select a book from the Dashboard to view its beat coverage."
              />
            ) : !beatCoverage ? (
              <EmptyState
                icon={<Target className="size-6" />}
                title="No archetype assigned"
                description="Assign an archetype to your book to see the beat map."
              />
            ) : (
              <FadeIn>
                <Card>
                  <CardHeader>
                    <CardTitle>Beat Coverage — {beatCoverage.coveragePercent}%</CardTitle>
                    <CardDescription>Archetype: {beatCoverage.archetypeId}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <Progress value={beatCoverage.coveragePercent} className="h-2 mb-4" />
                    {beatCoverage.beats.map(
                      (beat: {
                        key: string;
                        name: string;
                        status: string;
                        expectedPosition: number;
                      }) => (
                        <div
                          key={beat.key}
                          className="flex items-center gap-3 rounded-[--radius-md] border border-border-muted bg-surface-sunken px-3 py-2"
                        >
                          <div
                            className={`size-2 rounded-full ${beat.status !== 'pending' ? 'bg-accent-500' : 'bg-border-muted'}`}
                          />
                          <span className="text-[length:--text-sm] text-text-primary flex-1">
                            {beat.name}
                          </span>
                          <Badge
                            variant={beat.status !== 'pending' ? 'success' : 'default'}
                            className="text-[10px]"
                          >
                            {beat.status}
                          </Badge>
                          <span className="text-[length:--text-xs] text-text-muted w-12 text-right">
                            {Math.round(beat.expectedPosition * 100)}%
                          </span>
                        </div>
                      ),
                    )}
                  </CardContent>
                </Card>
              </FadeIn>
            )}
          </TabsContent>

          {/* ── Plot Threads Tab ─────────────── */}
          <TabsContent value="threads" className="mt-6 space-y-4">
            <PlotThreadWorkflow />
          </TabsContent>
        </Tabs>
      </div>
    </PageTransition>
  );
}
