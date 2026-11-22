import { publicReadinessView } from '../../api/readinessView';

test('public readiness exposes bounded states without private topology or errors', () => {
  const view = publicReadinessView({ databaseReady: false, redisStatus: 'private host connection refused', editorialRegistryReady: true, editorialCorpusReady: false });
  expect(view).toEqual({
    components: { database: 'unavailable', redis: 'unavailable', editorialRegistry: 'ready', editorialCorpus: 'unavailable', workers: 'disabled', redisPersistence: 'unavailable' },
    ready: false,
  });
  expect(JSON.stringify(view)).not.toMatch(/host|connection refused|model|queue|token|budget/i);
});
test('configured queues require fresh consumers and persistent Redis', () => {
  const input = { databaseReady: true, redisStatus: 'healthy', editorialRegistryReady: true, editorialCorpusReady: true, workerStatus: 'ready' as const, redisPersistenceReady: true };
  expect(publicReadinessView(input).ready).toBe(true);
  expect(publicReadinessView({ ...input, workerStatus: 'unavailable' }).ready).toBe(false);
  expect(publicReadinessView({ ...input, redisPersistenceReady: false }).ready).toBe(false);
});
