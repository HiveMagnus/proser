'use client';

import { useProtectedRouter as useRouter } from '@/hooks/use-protected-router';
import {
  ArrowLeft,
  Target,
  CheckCircle2,
  Circle,
  Plus,
  Sparkles,
  BookOpen,
  Layers,
  GitBranch,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

// Demo data — matches the Hero's Journey archetype
const archetype = {
  id: 'heros-journey',
  name: "The Hero's Journey",
  description:
    "The quintessential narrative structure where an ordinary person ventures into the unknown, faces escalating trials, achieves a decisive victory, and returns home transformed. Joseph Campbell's monomyth remains the most widely used plot framework in commercial fiction.",
  genres: ['Fantasy', 'Sci-Fi', 'Adventure', 'Literary'],
  contentRating: 'universal',
  beats: [
    {
      id: 'b1',
      name: 'Ordinary World',
      act: 1,
      description:
        'The hero in their mundane life. Establish what they have to lose and what internal flaw or longing drives them.',
      mapped: true,
      sceneCount: 2,
    },
    {
      id: 'b2',
      name: 'Call to Adventure',
      act: 1,
      description: 'An event disrupts the status quo and offers the hero a path into the unknown.',
      mapped: true,
      sceneCount: 1,
    },
    {
      id: 'b3',
      name: 'Refusal of the Call',
      act: 1,
      description:
        'Fear, obligation, or doubt holds the hero back. The stakes of inaction must escalate.',
      mapped: true,
      sceneCount: 1,
    },
    {
      id: 'b4',
      name: 'Meeting the Mentor',
      act: 1,
      description: 'A guide provides wisdom, tools, or confidence needed to cross the threshold.',
      mapped: false,
      sceneCount: 0,
    },
    {
      id: 'b5',
      name: 'Crossing the Threshold',
      act: 1,
      description:
        'The hero commits to the adventure and enters the special world. No turning back.',
      mapped: true,
      sceneCount: 1,
    },
    {
      id: 'b6',
      name: 'Tests, Allies, Enemies',
      act: 2,
      description:
        'The hero navigates the new world, builds bonds, learns rules, and identifies foes.',
      mapped: true,
      sceneCount: 3,
    },
    {
      id: 'b7',
      name: 'Approach to the Inmost Cave',
      act: 2,
      description: 'Preparation for the central ordeal. Tension builds. Plans are made.',
      mapped: false,
      sceneCount: 0,
    },
    {
      id: 'b8',
      name: 'The Ordeal',
      act: 2,
      description:
        'The hero faces the greatest danger yet. Death (literal or figurative) is a real possibility.',
      mapped: false,
      sceneCount: 0,
    },
    {
      id: 'b9',
      name: 'Reward (Seizing the Sword)',
      act: 2,
      description: 'Victory brings a prize — an object, knowledge, reconciliation, or power.',
      mapped: false,
      sceneCount: 0,
    },
    {
      id: 'b10',
      name: 'The Road Back',
      act: 3,
      description: 'The hero begins the return, but consequences of the ordeal create new urgency.',
      mapped: false,
      sceneCount: 0,
    },
    {
      id: 'b11',
      name: 'Resurrection',
      act: 3,
      description: 'A final test where the hero must apply everything learned. The climax.',
      mapped: false,
      sceneCount: 0,
    },
    {
      id: 'b12',
      name: 'Return with the Elixir',
      act: 3,
      description:
        'The hero returns home transformed, bearing gifts or wisdom for the ordinary world.',
      mapped: false,
      sceneCount: 0,
    },
  ],
  tips: [
    'The mentor does not need to be a wise old man — it can be a book, a memory, or an unlikely friend.',
    'The Ordeal should force the hero to confront their inner flaw, not just an external enemy.',
    'Modern readers expect the hero to earn their transformation, not receive it passively.',
    'Consider subverting expectations at the Reward stage — what if the prize is not what they expected?',
  ],
};

export default function ArchetypeDetailPage() {
  const router = useRouter();

  const mappedCount = archetype.beats.filter((b) => b.mapped).length;
  const coverage = Math.round((mappedCount / archetype.beats.length) * 100);
  const acts = [1, 2, 3];

  return (
    <div className="space-y-6 animate-[fade-in_400ms_var(--ease-out-expo)]">
      {/* ── Header ─────────────────────────── */}
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-4">
          <button
            onClick={() => router.push('/plot')}
            className="mt-1 rounded-[--radius-md] p-1.5 text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors cursor-pointer"
          >
            <ArrowLeft className="size-5" />
          </button>
          <div>
            <h1 className="font-[--font-display] text-[length:--text-3xl] font-bold tracking-tight text-text-primary">
              {archetype.name}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {archetype.genres.map((genre) => (
                <Badge key={genre} variant="default">
                  {genre}
                </Badge>
              ))}
              <Badge variant="accent">{archetype.beats.length} beats</Badge>
              <span className="text-[length:--text-xs] text-text-muted">
                {coverage}% mapped to manuscript
              </span>
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary">
            <Layers className="mr-2 size-4" />
            Blend with...
          </Button>
          <Button>
            <Sparkles className="mr-2 size-4" />
            Apply to Project
          </Button>
        </div>
      </div>

      {/* ── Description ────────────────────── */}
      <Card>
        <CardContent className="py-4">
          <p className="text-[length:--text-sm] leading-relaxed text-text-secondary">
            {archetype.description}
          </p>
        </CardContent>
      </Card>

      {/* ── Coverage Progress ──────────────── */}
      <div className="flex items-center gap-4 rounded-[--radius-lg] border border-border-muted bg-surface-raised p-4">
        <div className="flex-1">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[length:--text-sm] font-medium text-text-primary">
              Beat Coverage
            </span>
            <span className="text-[length:--text-sm] font-medium text-accent-400">{coverage}%</span>
          </div>
          <Progress value={coverage} className="h-2" />
          <p className="mt-1.5 text-[length:--text-xs] text-text-muted">
            {mappedCount} of {archetype.beats.length} beats mapped to scenes
          </p>
        </div>
      </div>

      <Tabs defaultValue="beats">
        <TabsList>
          <TabsTrigger value="beats">
            <Target className="mr-1.5 size-4" />
            Beat Spine
          </TabsTrigger>
          <TabsTrigger value="tips">
            <Zap className="mr-1.5 size-4" />
            Writing Tips
          </TabsTrigger>
          <TabsTrigger value="gaps">
            <GitBranch className="mr-1.5 size-4" />
            Gap Analysis
          </TabsTrigger>
        </TabsList>

        {/* ── Beats Tab ────────────────────── */}
        <TabsContent value="beats" className="mt-6 space-y-6">
          {acts.map((act) => {
            const actBeats = archetype.beats.filter((b) => b.act === act);
            return (
              <div key={act}>
                <h3 className="mb-3 text-[length:--text-xs] font-semibold text-text-muted uppercase tracking-wider">
                  Act {act}
                </h3>
                <div className="space-y-2">
                  {actBeats.map((beat, idx) => (
                    <Card
                      key={beat.id}
                      className={cn(
                        'transition-all duration-[--duration-normal] cursor-pointer',
                        beat.mapped
                          ? 'border-accent-500/20 hover:border-accent-500/40'
                          : 'hover:border-border-strong',
                      )}
                    >
                      <CardContent className="flex items-start gap-4 py-3">
                        {/* ── Status indicator ── */}
                        <div className="mt-0.5 shrink-0">
                          {beat.mapped ? (
                            <CheckCircle2 className="size-5 text-accent-400" />
                          ) : (
                            <Circle className="size-5 text-border-strong" />
                          )}
                        </div>

                        {/* ── Beat number & connector */}
                        <div className="relative flex flex-col items-center shrink-0">
                          <div
                            className={cn(
                              'flex size-8 items-center justify-center rounded-[--radius-full] text-[length:--text-xs] font-bold',
                              beat.mapped
                                ? 'bg-accent-500/15 text-accent-300'
                                : 'bg-surface-sunken text-text-muted',
                            )}
                          >
                            {idx + 1}
                          </div>
                        </div>

                        {/* ── Content ── */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-[length:--text-sm] font-semibold text-text-primary">
                              {beat.name}
                            </p>
                            {beat.mapped && (
                              <span className="text-[length:--text-xs] text-text-muted">
                                {beat.sceneCount} scene{beat.sceneCount !== 1 ? 's' : ''}
                              </span>
                            )}
                          </div>
                          <p className="mt-1 text-[length:--text-sm] text-text-secondary leading-relaxed">
                            {beat.description}
                          </p>
                        </div>

                        {/* ── Action ── */}
                        <div className="shrink-0">
                          {beat.mapped ? (
                            <Button variant="ghost" size="sm">
                              <BookOpen className="mr-1.5 size-3.5" />
                              View
                            </Button>
                          ) : (
                            <Button variant="secondary" size="sm">
                              <Plus className="mr-1.5 size-3.5" />
                              Map
                            </Button>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>
            );
          })}
        </TabsContent>

        {/* ── Tips Tab ─────────────────────── */}
        <TabsContent value="tips" className="mt-6">
          <div className="space-y-3">
            {archetype.tips.map((tip, i) => (
              <Card key={i}>
                <CardContent className="flex items-start gap-3 py-3">
                  <Zap className="mt-0.5 size-4 shrink-0 text-accent-400" />
                  <p className="text-[length:--text-sm] text-text-secondary leading-relaxed">
                    {tip}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        {/* ── Gap Analysis Tab ─────────────── */}
        <TabsContent value="gaps" className="mt-6 space-y-4">
          {archetype.beats.filter((b) => !b.mapped).length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <CheckCircle2 className="mx-auto mb-3 size-8 text-success" />
                <p className="text-[length:--text-sm] font-medium text-text-primary">
                  All beats covered!
                </p>
                <p className="mt-1 text-[length:--text-xs] text-text-muted">
                  Every beat in the archetype has at least one mapped scene.
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              <p className="text-[length:--text-sm] text-text-secondary">
                The following beats have no mapped scenes. Consider writing scenes to cover these
                structural elements.
              </p>
              {archetype.beats
                .filter((b) => !b.mapped)
                .map((beat) => (
                  <Card key={beat.id} className="border-warning/20">
                    <CardContent className="flex items-center justify-between py-3">
                      <div className="flex items-center gap-3">
                        <div className="flex size-6 items-center justify-center rounded-[--radius-full] bg-warning/15 text-[length:--text-xs] font-bold text-warning">
                          !
                        </div>
                        <div>
                          <p className="text-[length:--text-sm] font-medium text-text-primary">
                            {beat.name}
                          </p>
                          <p className="text-[length:--text-xs] text-text-muted">
                            Act {beat.act} — No scenes mapped
                          </p>
                        </div>
                      </div>
                      <Button variant="secondary" size="sm">
                        <Sparkles className="mr-1.5 size-3.5" />
                        Generate Scene
                      </Button>
                    </CardContent>
                  </Card>
                ))}
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
