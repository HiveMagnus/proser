import redis from '@/lib/redis';

const counters = new Map<string, number>();
const durations = new Map<string, { count: number; sumMs: number; maxMs: number }>();
const prefix = process.env.BULLMQ_PREFIX || 'proser';
const counterKey = `${prefix}:metrics:editorial:counters`;
const durationKey = `${prefix}:metrics:editorial:durations`;

export async function incrementEditorialMetric(name: string, amount = 1) {
  counters.set(name, (counters.get(name) ?? 0) + amount);
  try {
    await redis.hincrby(counterKey, name, amount);
  } catch {
    // Local counters remain available for development without Redis.
  }
}

export async function observeEditorialDuration(name: string, milliseconds: number) {
  const value = Math.max(0, milliseconds);
  const local = durations.get(name) ?? { count: 0, sumMs: 0, maxMs: 0 };
  durations.set(name, {
    count: local.count + 1,
    sumMs: local.sumMs + value,
    maxMs: Math.max(local.maxMs, value),
  });
  try {
    await redis.eval(
      `
      redis.call('HINCRBY', KEYS[1], ARGV[1] .. ':count', 1)
      redis.call('HINCRBYFLOAT', KEYS[1], ARGV[1] .. ':sumMs', ARGV[2])
      local current = tonumber(redis.call('HGET', KEYS[1], ARGV[1] .. ':maxMs') or '0')
      if tonumber(ARGV[2]) > current then
        redis.call('HSET', KEYS[1], ARGV[1] .. ':maxMs', ARGV[2])
      end
      return 1
      `,
      1,
      durationKey,
      name,
      String(value),
    );
  } catch {
    // Local histograms remain available for development without Redis.
  }
}

export async function editorialMetricsSnapshot() {
  try {
    const [sharedCounters, sharedDurations] = await Promise.all([
      redis.hgetall(counterKey),
      redis.hgetall(durationKey),
    ]);
    const names = [...new Set(Object.keys(sharedDurations).map((field) => field.replace(/:(?:count|sumMs|maxMs)$/, '')))];
    return {
      counters: Object.fromEntries(Object.entries(sharedCounters).map(([key, value]) => [key, Number(value)])),
      durations: Object.fromEntries(names.map((name) => {
        const count = Number(sharedDurations[`${name}:count`] ?? 0);
        const sumMs = Number(sharedDurations[`${name}:sumMs`] ?? 0);
        return [name, {
          count,
          meanMs: sumMs / Math.max(1, count),
          maxMs: Number(sharedDurations[`${name}:maxMs`] ?? 0),
        }];
      })),
    };
  } catch {
    return {
      counters: Object.fromEntries(counters),
      durations: Object.fromEntries([...durations].map(([key, value]) => [key, {
        count: value.count,
        meanMs: value.sumMs / Math.max(1, value.count),
        maxMs: value.maxMs,
      }])),
    };
  }
}
