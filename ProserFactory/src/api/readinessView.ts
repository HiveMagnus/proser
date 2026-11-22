export function publicReadinessView(input: {
  databaseReady: boolean;
  redisStatus: string;
  editorialRegistryReady: boolean;
  editorialCorpusReady: boolean;
  workerStatus?: 'ready' | 'disabled' | 'unavailable';
  redisPersistenceReady?: boolean;
  documents?: import('@/documents/runtimeReadiness').DocumentRuntimeReadiness;
}) {
  return {
    components: {
      database: input.databaseReady ? 'ready' : 'unavailable',
      redis: input.redisStatus === 'healthy' || input.redisStatus === 'disabled' ? input.redisStatus : 'unavailable',
      editorialRegistry: input.editorialRegistryReady ? 'ready' : 'unavailable',
      editorialCorpus: input.editorialCorpusReady ? 'ready' : 'unavailable',
      workers: input.workerStatus ?? 'disabled',
      redisPersistence: input.redisStatus === 'disabled' ? 'disabled' : input.redisPersistenceReady ? 'ready' : 'unavailable',
      ...(input.documents ?? {}),
    },
    ready: input.databaseReady
      && ['healthy', 'disabled'].includes(input.redisStatus)
      && input.editorialRegistryReady
      && input.editorialCorpusReady
      && input.workerStatus !== 'unavailable'
      && (input.redisStatus === 'disabled' || input.redisPersistenceReady === true)
      && Object.values(input.documents ?? {}).every((status) => status === 'ready' || status === 'disabled'),
  };
}
