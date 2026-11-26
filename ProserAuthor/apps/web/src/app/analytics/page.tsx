'use client';

import { useEffect, useMemo, useState } from 'react';
import { BarChart3, Flame, Target } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, StatCard } from '@/components/ui/data-display';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useWorkspace } from '@/contexts/workspace-context';
import { useSetWritingGoal, useWritingStats } from '@/hooks/queries/use-writing-stats';
import type { WritingDay, WritingGoal } from '@/lib/api';

const number = (value: number) => value.toLocaleString();

function DailyBars({ days, label }: { days: WritingDay[]; label: string }) {
  const max = Math.max(...days.map((day) => day.written), 1);
  return (
    <div role="img" aria-label={label} className="flex h-48 items-end gap-px">
      {days.map((day) => (
        <div
          key={day.date}
          className="min-w-[2px] flex-1 rounded-t-[1px] bg-accent-500/60 hover:bg-accent-400/80"
          style={{ height: day.written > 0 ? `${(day.written / max) * 100}%` : '1px' }}
          title={`${day.date}: ${number(day.written)} words written${
            day.other ? `, ${number(day.other)} imported or generated` : ''
          }`}
        />
      ))}
    </div>
  );
}

const parseGoalNumber = (value: string) => {
  const trimmed = value.trim().replace(/[,\s]/g, '');
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : NaN;
};

function GoalForm({ bookId, goal }: { bookId: string; goal: WritingGoal | null }) {
  const save = useSetWritingGoal(bookId);
  const [target, setTarget] = useState('');
  const [deadline, setDeadline] = useState('');
  const [daily, setDaily] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    setTarget(goal?.targetWords ? String(goal.targetWords) : '');
    setDeadline(goal?.deadline ?? '');
    setDaily(goal?.dailyWords ? String(goal.dailyWords) : '');
  }, [goal]);

  const submit = (next: WritingGoal) => {
    setError('');
    save.mutate(next, {
      onError: (failure) =>
        setError(failure instanceof Error ? failure.message : 'The goal could not be saved.'),
    });
  };

  return (
    <form
      className="grid gap-4 sm:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        const targetWords = parseGoalNumber(target);
        const dailyWords = parseGoalNumber(daily);
        if (Number.isNaN(targetWords) || Number.isNaN(dailyWords)) {
          setError('Use whole numbers above zero, or leave a field empty.');
          return;
        }
        submit({ targetWords, dailyWords, deadline: deadline || null });
      }}
    >
      <label className="grid gap-1.5 text-[length:--text-sm] text-text-primary">
        Book length target (words)
        <Input inputMode="numeric" value={target} onChange={(e) => setTarget(e.target.value)} />
      </label>
      <label className="grid gap-1.5 text-[length:--text-sm] text-text-primary">
        Deadline
        <Input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
      </label>
      <label className="grid gap-1.5 text-[length:--text-sm] text-text-primary">
        Daily goal (words)
        <Input inputMode="numeric" value={daily} onChange={(e) => setDaily(e.target.value)} />
      </label>
      <div className="flex flex-wrap items-center gap-2 sm:col-span-3">
        <Button type="submit" disabled={save.isPending}>
          Save goal
        </Button>
        {goal ? (
          <Button
            type="button"
            variant="ghost"
            disabled={save.isPending}
            onClick={() => submit({ targetWords: null, deadline: null, dailyWords: null })}
          >
            Clear goal
          </Button>
        ) : null}
        {error ? (
          <p role="alert" className="text-[length:--text-sm] text-red-300">
            {error}
          </p>
        ) : save.isSuccess ? (
          <p role="status" className="text-[length:--text-sm] text-text-muted">
            Goal saved.
          </p>
        ) : null}
      </div>
    </form>
  );
}

export default function AnalyticsPage() {
  const { activeBookId, activeBookTitle } = useWorkspace();
  const { data: stats, isLoading, error } = useWritingStats(activeBookId, 30);
  const { data: quarter } = useWritingStats(activeBookId, 90);
  const lastWeek = useMemo(() => stats?.days.slice(-7) ?? [], [stats]);

  if (!activeBookId) {
    return (
      <EmptyState
        icon={<BarChart3 className="size-6" />}
        title="Choose a book"
        description="Open a book from the Dashboard to see its writing progress."
      />
    );
  }

  const pacing = stats?.pacing;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-[--font-display] text-[length:--text-3xl] font-bold tracking-tight text-text-primary">
          Analytics
        </h1>
        <p className="mt-1 text-[length:--text-sm] text-text-secondary">
          Writing progress for {activeBookTitle ?? 'this book'}. Words count when you save them;
          imported and generated text is shown separately.
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-[length:--text-sm] text-red-300">
          {error instanceof Error ? error.message : 'Writing statistics are unavailable.'}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Words in the book"
          value={isLoading ? '…' : number(stats?.totalWords ?? 0)}
        />
        <StatCard
          label="Written, last 30 days"
          value={number(stats?.writtenInPeriod ?? 0)}
          sublabel={`${number(stats?.dailyAverage ?? 0)} a day on average`}
        />
        <StatCard
          label="Best day"
          value={stats?.bestDay ? number(stats.bestDay.written) : '—'}
          sublabel={stats?.bestDay?.date}
        />
        <StatCard
          label="Writing streak"
          value={
            <span className="flex items-center gap-1.5">
              <Flame className="size-4 text-orange-400" aria-hidden="true" />
              {stats?.streak.current ?? 0}
              <span className="text-[length:--text-sm] text-text-muted">days</span>
            </span>
          }
          sublabel={`Longest in 30 days: ${stats?.streak.longest ?? 0}`}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Target className="size-4" aria-hidden="true" />
            Goals
          </CardTitle>
          <CardDescription>
            {pacing
              ? [
                  pacing.todayRemaining !== null
                    ? pacing.todayRemaining > 0
                      ? `${number(pacing.todayRemaining)} words to go today.`
                      : 'Today’s goal is done.'
                    : null,
                  pacing.wordsPerDayNeeded !== null && pacing.daysLeft
                    ? `${number(pacing.remainingWords)} words left: about ${number(
                        pacing.wordsPerDayNeeded,
                      )} a day for ${pacing.daysLeft} ${pacing.daysLeft === 1 ? 'day' : 'days'}.`
                    : pacing.remainingWords > 0
                      ? `${number(pacing.remainingWords)} words to the target.`
                      : stats?.goal?.targetWords
                        ? 'The book has reached its target length.'
                        : null,
                ]
                  .filter(Boolean)
                  .join(' ')
              : 'Set a length target, a deadline or a daily goal. A daily goal also sets what counts toward the streak.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <GoalForm bookId={activeBookId} goal={stats?.goal ?? null} />
        </CardContent>
      </Card>

      <Tabs defaultValue="week">
        <TabsList>
          <TabsTrigger value="week">Last 7 days</TabsTrigger>
          <TabsTrigger value="month">Last 30 days</TabsTrigger>
          <TabsTrigger value="quarter">Last 90 days</TabsTrigger>
        </TabsList>
        {[
          { value: 'week', days: lastWeek },
          { value: 'month', days: stats?.days ?? [] },
          { value: 'quarter', days: quarter?.days ?? [] },
        ].map((tab) => (
          <TabsContent key={tab.value} value={tab.value} className="mt-6">
            {tab.days.some((day) => day.written > 0) ? (
              <Card>
                <CardContent className="pt-6">
                  <DailyBars days={tab.days} label="Words written each day" />
                  <ul className="sr-only">
                    {tab.days.map((day) => (
                      <li key={day.date}>
                        {day.date}: {number(day.written)} words
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ) : (
              <EmptyState
                icon={<BarChart3 className="size-6" />}
                title="No words written in this period"
                description="Write and save in the Manuscript to see daily progress here."
              />
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
