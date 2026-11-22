type MetricSample = { name: string; durationMs: number; timestamp: number };
const timings: MetricSample[] = [];

export function time<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  return fn().then((res) => { timings.push({ name, durationMs: performance.now() - start, timestamp: Date.now() }); return res; })
    .catch(err => { timings.push({ name, durationMs: performance.now() - start, timestamp: Date.now() }); throw err; });
}

export function getTimings(limit = 200) {
  return timings.slice(-limit);
}

export function getSummary() {
  const grouped: Record<string, { count: number; avg: number; max: number }> = {};
  for (const t of timings) {
    if (!grouped[t.name]) grouped[t.name] = { count: 0, avg: 0, max: 0 };
    const g = grouped[t.name];
    g.count += 1;
    g.avg += (t.durationMs - g.avg) / g.count;
    if (t.durationMs > g.max) g.max = t.durationMs;
  }
  return grouped;
}
