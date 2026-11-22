'use client';

import { useMemo } from 'react';
import { BarChart3, TrendingUp, Calendar, Flame } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatCard, EmptyState } from '@/components/ui/data-display';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useWorkspace } from '@/contexts/workspace-context';
import { useWritingStats } from '@/hooks/queries/use-analytics';
import { AsyncBoundary } from '@/components/ui/async-boundary';
import { PageTransition, AnimatedNumber } from '@/components/motion/primitives';

export default function AnalyticsPage() {
  const { activeBookId } = useWorkspace();
  const { data: stats, isLoading, error } = useWritingStats(activeBookId, 30);
  const { data: monthlyStats } = useWritingStats(activeBookId, 90);

  // Compute weekly data from daily stats
  const weeklyData = useMemo(() => {
    if (!stats?.daily?.length) return [];
    const last7 = stats.daily.slice(-7);
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return last7.map((d: { date: string; wordCount: number }) => ({
      day: dayNames[new Date(d.date + 'T12:00:00').getDay()] ?? '?',
      words: d.wordCount,
    }));
  }, [stats]);

  const maxWords = Math.max(...weeklyData.map((d: { words: number }) => d.words), 1);

  return (
    <PageTransition>
      <div className="space-y-6">
        <div>
          <h1 className="font-[--font-display] text-[length:--text-3xl] font-bold tracking-tight text-text-primary">
            Analytics
          </h1>
          <p className="mt-1 text-[length:--text-sm] text-text-secondary">
            Writing progress, word counts, and productivity insights.
          </p>
        </div>

        {/* ── Overview Stats ─────────────────── */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Total Words"
            value={
              <AnimatedNumber value={stats?.totalWords ?? 0} format={(n) => n.toLocaleString()} />
            }
          />
          <StatCard
            label="Daily Average"
            value={
              <AnimatedNumber value={stats?.dailyAverage ?? 0} format={(n) => n.toLocaleString()} />
            }
          />
          <StatCard
            label="Best Day"
            value={stats?.bestDay ? `${stats.bestDay.wordCount.toLocaleString()}` : '—'}
            sublabel={stats?.bestDay?.date}
          />
          <StatCard
            label="Writing Streak"
            value={
              <span className="flex items-center gap-1.5">
                <Flame className="size-4 text-orange-400" />
                <AnimatedNumber value={stats?.streakDays ?? 0} />
                <span className="text-[length:--text-sm] text-text-muted">days</span>
              </span>
            }
          />
        </div>

        <Tabs defaultValue="weekly">
          <TabsList>
            <TabsTrigger value="weekly">
              <Calendar className="mr-1.5 size-4" />
              Weekly
            </TabsTrigger>
            <TabsTrigger value="monthly">
              <TrendingUp className="mr-1.5 size-4" />
              Monthly
            </TabsTrigger>
          </TabsList>

          <TabsContent value="weekly" className="mt-6">
            <AsyncBoundary
              isLoading={isLoading}
              error={error}
              isEmpty={weeklyData.length === 0}
              emptyTitle="No data yet"
              emptyDescription="Start writing to see your weekly stats."
              emptyIcon={<BarChart3 className="size-6" />}
            >
              <Card>
                <CardHeader>
                  <CardTitle>This Week&apos;s Output</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-end justify-between gap-2 sm:gap-3 h-48">
                    {weeklyData.map((d: { day: string; words: number }) => (
                      <div key={d.day} className="flex flex-1 flex-col items-center gap-2">
                        <span className="text-[length:--text-xs] text-text-muted hidden sm:block">
                          {d.words > 0 ? d.words.toLocaleString() : '—'}
                        </span>
                        <div className="w-full max-w-8 flex-1 flex items-end">
                          <div
                            className="w-full rounded-t-[--radius-sm] bg-accent-500/70 transition-all duration-[--duration-slow]"
                            style={{
                              height: d.words > 0 ? `${(d.words / maxWords) * 100}%` : '2px',
                            }}
                          />
                        </div>
                        <span className="text-[length:--text-xs] font-medium text-text-muted">
                          {d.day}
                        </span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </AsyncBoundary>
          </TabsContent>

          <TabsContent value="monthly" className="mt-6">
            {!monthlyStats?.daily?.length ? (
              <EmptyState
                icon={<BarChart3 className="size-6" />}
                title="Not enough data yet"
                description="Keep writing to see monthly trends."
              />
            ) : (
              <Card>
                <CardHeader>
                  <CardTitle>Last 90 Days</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-end gap-px h-48">
                    {monthlyStats.daily.map((d: { date: string; wordCount: number }) => {
                      const maxM = Math.max(
                        ...monthlyStats.daily.map((x: { wordCount: number }) => x.wordCount),
                        1,
                      );
                      return (
                        <div
                          key={d.date}
                          className="flex-1 bg-accent-500/50 rounded-t-[1px] transition-all duration-100 hover:bg-accent-400/70 min-w-[2px]"
                          style={{
                            height: d.wordCount > 0 ? `${(d.wordCount / maxM) * 100}%` : '1px',
                          }}
                          title={`${d.date}: ${d.wordCount.toLocaleString()} words`}
                        />
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </PageTransition>
  );
}
