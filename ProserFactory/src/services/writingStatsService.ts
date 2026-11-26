import { Prisma } from '@prisma/client';
import { databaseService } from '@/lib/database';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { findArchetypeById } from '@/config/storyArchetypes';

/**
 * Writing statistics come from the saved book revisions: each book revision's
 * manifest records every scene's revision and word count. The last revision of
 * each local day is that day's snapshot, so a day's words are the change from
 * the previous snapshot. A scene's change is credited to the writer when the
 * scene revision in the day's snapshot was saved by hand; text added by
 * imports, AI or workflows is reported separately so it never fills a goal.
 */

export interface SnapshotScene {
  sceneId: number;
  revisionId: string;
  wordCount: number;
  deletedAt?: string | null;
}
export interface DaySnapshot {
  day: string;
  scenes: SnapshotScene[];
}
export interface WritingGoal {
  targetWords: number | null;
  deadline: string | null;
  dailyWords: number | null;
}
export interface WritingDay {
  date: string;
  /** Net words changed in scenes the writer saved by hand. */
  written: number;
  /** Net words changed by imports, AI generation and workflows. */
  other: number;
  /** Words in the book at the end of the day. */
  totalWords: number;
}
export interface WritingStats {
  bookId: number;
  timeZone: string;
  today: string;
  totalWords: number;
  days: WritingDay[];
  writtenInPeriod: number;
  dailyAverage: number;
  bestDay: { date: string; written: number } | null;
  streak: { current: number; longest: number };
  goal: WritingGoal | null;
  pacing: {
    remainingWords: number;
    daysLeft: number | null;
    wordsPerDayNeeded: number | null;
    todayRemaining: number | null;
  } | null;
}

const HAND_ORIGINS = new Set(['manual']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validTimeZone(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'UTC';
  if (typeof value !== 'string' || value.length > 64) throw new ValidationError('tz must be an IANA time zone');
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new ValidationError('tz must be an IANA time zone');
  }
}

const databaseTimeZones = new Map<string, boolean>();
/** PostgreSQL's zone database can lag the runtime's; refuse zones it does not know. */
export async function requireDatabaseTimeZone(timeZone: string): Promise<void> {
  let known = databaseTimeZones.get(timeZone);
  if (known === undefined) {
    const rows = await databaseService.client.$queryRaw<Array<{ known: boolean }>>(Prisma.sql`SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = ${timeZone}) AS known`);
    known = rows[0]?.known === true;
    databaseTimeZones.set(timeZone, known);
  }
  if (!known) throw new ValidationError('tz is not a time zone the database knows');
}

export function localDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function addDays(day: string, offset: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

const activeScenes = (snapshot: DaySnapshot | undefined) => new Map(
  (snapshot?.scenes ?? []).filter((scene) => !scene.deletedAt).map((scene) => [scene.sceneId, scene]),
);
const words = (scenes: Map<number, SnapshotScene>) => [...scenes.values()].reduce((total, scene) => total + scene.wordCount, 0);

/** Pure summary of daily snapshots; see the module comment for the rules. */
export function summarizeWriting(input: {
  bookId: number;
  timeZone: string;
  today: string;
  days: number;
  baseline?: DaySnapshot;
  snapshots: DaySnapshot[];
  origins: Map<string, string>;
  goal: WritingGoal | null;
}): WritingStats {
  const start = addDays(input.today, -(input.days - 1));
  const byDay = new Map(input.snapshots.map((snapshot) => [snapshot.day, snapshot]));
  let previous = activeScenes(input.baseline);
  const days: WritingDay[] = [];
  for (let offset = 0; offset < input.days; offset += 1) {
    const date = addDays(start, offset);
    const snapshot = byDay.get(date);
    if (!snapshot) {
      days.push({ date, written: 0, other: 0, totalWords: words(previous) });
      continue;
    }
    const current = activeScenes(snapshot);
    let written = 0;
    let other = 0;
    for (const sceneId of new Set([...previous.keys(), ...current.keys()])) {
      const before = previous.get(sceneId);
      const after = current.get(sceneId);
      if (before && after && before.revisionId === after.revisionId) continue;
      const change = (after?.wordCount ?? 0) - (before?.wordCount ?? 0);
      const origin = after ? input.origins.get(after.revisionId) : before ? input.origins.get(before.revisionId) : undefined;
      if (after && origin && HAND_ORIGINS.has(origin)) written += change;
      else if (!after && before && origin && HAND_ORIGINS.has(origin)) written += change;
      else other += change;
    }
    days.push({ date, written, other, totalWords: words(current) });
    previous = current;
  }
  const totalWords = days.at(-1)?.totalWords ?? words(previous);
  const writtenInPeriod = days.reduce((total, day) => total + Math.max(0, day.written), 0);
  const best = days.reduce<WritingDay | null>((top, day) => (day.written > 0 && (!top || day.written > top.written) ? day : top), null);
  const threshold = input.goal?.dailyWords ?? 1;
  const met = days.map((day) => day.written >= threshold);
  let longest = 0;
  let run = 0;
  for (const value of met) { run = value ? run + 1 : 0; longest = Math.max(longest, run); }
  // Today still counts as in progress, so a streak survives until today ends.
  let current = 0;
  for (let index = met.length - 1; index >= 0; index -= 1) {
    if (met[index]) current += 1;
    else if (index === met.length - 1) continue;
    else break;
  }
  const todayWritten = days.at(-1)?.written ?? 0;
  let pacing: WritingStats['pacing'] = null;
  if (input.goal && (input.goal.targetWords || input.goal.dailyWords)) {
    const remainingWords = Math.max(0, (input.goal.targetWords ?? 0) - totalWords);
    const daysLeft = input.goal.deadline ? Math.max(0, daysBetween(input.today, input.goal.deadline) + 1) : null;
    pacing = {
      remainingWords,
      daysLeft,
      wordsPerDayNeeded: input.goal.targetWords && daysLeft ? Math.ceil(remainingWords / daysLeft) : null,
      todayRemaining: input.goal.dailyWords ? Math.max(0, input.goal.dailyWords - todayWritten) : null,
    };
  }
  return {
    bookId: input.bookId,
    timeZone: input.timeZone,
    today: input.today,
    totalWords,
    days,
    writtenInPeriod,
    dailyAverage: Math.round(writtenInPeriod / input.days),
    bestDay: best ? { date: best.date, written: best.written } : null,
    streak: { current, longest },
    goal: input.goal,
    pacing,
  };
}

function manifestScenes(manifest: unknown): SnapshotScene[] {
  const scenes = (manifest as { scenes?: unknown })?.scenes;
  if (!Array.isArray(scenes)) return [];
  return scenes.flatMap((scene) => {
    const item = scene as Partial<SnapshotScene>;
    return typeof item.sceneId === 'number' && typeof item.revisionId === 'string' && typeof item.wordCount === 'number'
      ? [{ sceneId: item.sceneId, revisionId: item.revisionId, wordCount: item.wordCount, deletedAt: item.deletedAt ?? null }]
      : [];
  });
}

async function ownedBook(userId: number, bookId: number) {
  const book = await databaseService.client.book.findFirst({ where: { id: bookId, userId, deletedAt: null }, select: { id: true, storyArchetypeKey: true } });
  if (!book) throw new NotFoundError('Book not found');
  return book;
}

function goalView(goal: { targetWords: number | null; deadline: Date | null; dailyWords: number | null } | null): WritingGoal | null {
  if (!goal) return null;
  return { targetWords: goal.targetWords, deadline: goal.deadline ? goal.deadline.toISOString().slice(0, 10) : null, dailyWords: goal.dailyWords };
}

export async function getWritingStats(userId: number, bookId: number, options: { days?: number; timeZone?: string; now?: Date } = {}): Promise<WritingStats> {
  await ownedBook(userId, bookId);
  const timeZone = validTimeZone(options.timeZone);
  await requireDatabaseTimeZone(timeZone);
  const days = options.days ?? 30;
  const today = localDate(options.now ?? new Date(), timeZone);
  const start = addDays(today, -(days - 1));
  const client = databaseService.client;
  // created_at is stored in UTC; the local midnight of the first day bounds the window.
  // Pick each day's last revision first, so only those manifests are read.
  const snapshots = await client.$queryRaw<Array<{ day: string; manifest: unknown }>>(Prisma.sql`
    SELECT picked.day, revision.manifest
    FROM (
      SELECT DISTINCT ON (day) id, day FROM (
        SELECT id, created_at, to_char((created_at AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day
        FROM book_document_revisions
        WHERE book_id = ${bookId}
          AND created_at >= ((${start}::date)::timestamp AT TIME ZONE ${timeZone}) AT TIME ZONE 'UTC'
      ) revisions
      ORDER BY day, created_at DESC
    ) picked
    JOIN book_document_revisions revision ON revision.id = picked.id
    ORDER BY picked.day`);
  const [baseline] = await client.$queryRaw<Array<{ manifest: unknown }>>(Prisma.sql`
    SELECT manifest FROM book_document_revisions
    WHERE book_id = ${bookId}
      AND created_at < ((${start}::date)::timestamp AT TIME ZONE ${timeZone}) AT TIME ZONE 'UTC'
    ORDER BY created_at DESC LIMIT 1`);
  const daySnapshots = snapshots.filter((row) => DATE.test(row.day)).map((row) => ({ day: row.day, scenes: manifestScenes(row.manifest) }));
  const baselineSnapshot = baseline ? { day: addDays(start, -1), scenes: manifestScenes(baseline.manifest) } : undefined;
  const revisionIds = [...new Set([...daySnapshots, ...(baselineSnapshot ? [baselineSnapshot] : [])].flatMap((snapshot) => snapshot.scenes.map((scene) => scene.revisionId)))];
  const origins = new Map<string, string>();
  for (let index = 0; index < revisionIds.length; index += 1000) {
    const rows = await client.sceneDocumentRevision.findMany({ where: { bookId, id: { in: revisionIds.slice(index, index + 1000) } }, select: { id: true, origin: true } });
    for (const row of rows) origins.set(row.id, row.origin);
  }
  const goal = await client.bookWritingGoal.findUnique({ where: { bookId } });
  return summarizeWriting({ bookId, timeZone, today, days, baseline: baselineSnapshot, snapshots: daySnapshots, origins, goal: goalView(goal) });
}

export async function setWritingGoal(userId: number, bookId: number, goal: WritingGoal): Promise<WritingGoal | null> {
  await ownedBook(userId, bookId);
  if (goal.deadline !== null && (!DATE.test(goal.deadline) || new Date(`${goal.deadline}T00:00:00Z`).toISOString().slice(0, 10) !== goal.deadline)) throw new ValidationError('deadline must be a real calendar date');
  const client = databaseService.client;
  if (goal.targetWords === null && goal.deadline === null && goal.dailyWords === null) {
    await client.bookWritingGoal.deleteMany({ where: { bookId } });
    return null;
  }
  const data = { targetWords: goal.targetWords, dailyWords: goal.dailyWords, deadline: goal.deadline ? new Date(`${goal.deadline}T00:00:00Z`) : null };
  return goalView(await client.bookWritingGoal.upsert({ where: { bookId }, create: { bookId, ...data }, update: data }));
}

export interface Recommendation {
  id: 'first-scene' | 'empty-scenes' | 'daily-goal' | 'deadline-pace' | 'story-bible' | 'archetype' | 'set-goal';
  title: string;
  detail: string;
  href: string;
}

/** Next steps derived from the book's saved state, most useful first. */
export async function getRecommendations(userId: number, bookId: number, options: { timeZone?: string; now?: Date } = {}): Promise<Recommendation[]> {
  const book = await ownedBook(userId, bookId);
  const stats = await getWritingStats(userId, bookId, { days: 7, timeZone: options.timeZone, now: options.now });
  const head = await databaseService.client.bookDocumentHead.findUnique({ where: { bookId }, select: { manifest: true } });
  const scenes = manifestScenes(head?.manifest).filter((scene) => !scene.deletedAt);
  const codexEntries = await databaseService.client.codexEntry.count({ where: { bookId, deletedAt: null } });
  const items: Recommendation[] = [];
  const manuscript = '/manuscript';
  if (scenes.length === 0) items.push({ id: 'first-scene', title: 'Write the first scene', detail: 'The book has no scenes yet. Add one in the Manuscript and start writing.', href: manuscript });
  const empty = scenes.filter((scene) => scene.wordCount === 0).length;
  if (empty > 0 && scenes.length > 0) items.push({ id: 'empty-scenes', title: `${empty} ${empty === 1 ? 'scene is' : 'scenes are'} still empty`, detail: 'Draft them, or remove scenes you no longer need.', href: manuscript });
  if (stats.pacing?.todayRemaining) items.push({ id: 'daily-goal', title: `${stats.pacing.todayRemaining.toLocaleString('en-US')} words to today's goal`, detail: `Your daily goal is ${stats.goal!.dailyWords!.toLocaleString('en-US')} words.`, href: manuscript });
  if (stats.pacing?.wordsPerDayNeeded && stats.pacing.daysLeft) items.push({ id: 'deadline-pace', title: `${stats.pacing.wordsPerDayNeeded.toLocaleString('en-US')} words a day to finish on time`, detail: `${stats.pacing.remainingWords.toLocaleString('en-US')} words remain with ${stats.pacing.daysLeft} ${stats.pacing.daysLeft === 1 ? 'day' : 'days'} to the deadline.`, href: '/analytics' });
  if (!stats.goal) items.push({ id: 'set-goal', title: 'Set a word-count goal', detail: 'A target, deadline or daily goal turns on pacing and streaks.', href: '/analytics' });
  if (codexEntries === 0) items.push({ id: 'story-bible', title: 'Start the Story Bible', detail: 'Add the main characters and places so they stay consistent.', href: '/bible' });
  if (!findArchetypeById(book.storyArchetypeKey)) items.push({ id: 'archetype', title: 'Choose a story archetype', detail: 'Plot Studio describes the shape your story follows.', href: '/plot' });
  return items;
}
