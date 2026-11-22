import {
  assertRedisPersistence,
  type RedisPersistenceClient,
} from '@/lib/redis/persistencePreflight';

function fakeClient(overrides: Partial<RedisPersistenceClient> = {}): RedisPersistenceClient {
  let value: string | null = null;
  let infoCalls = 0;
  return {
    set: jest.fn(async (_key: string, next: string) => {
      value = next;
      return 'OK';
    }),
    get: jest.fn(async () => value),
    del: jest.fn(async () => {
      value = null;
      return 1;
    }),
    bgsave: jest.fn(async () => 'Background saving started'),
    info: jest.fn(async () => {
      infoCalls += 1;
      return infoCalls === 1
        ? 'rdb_bgsave_in_progress:1\r\nrdb_last_bgsave_status:ok\r\nrdb_saves_consecutive_failures:0\r\n'
        : 'rdb_bgsave_in_progress:0\r\nrdb_last_bgsave_status:ok\r\nrdb_saves_consecutive_failures:0\r\n';
    }),
    ...overrides,
  } as unknown as RedisPersistenceClient;
}

describe('Redis deployment persistence preflight', () => {
  it('proves writes before and after a successful background snapshot', async () => {
    const client = fakeClient();
    await expect(assertRedisPersistence(client, { pollIntervalMs: 0 })).resolves.toBeUndefined();
    expect(client.set).toHaveBeenCalledTimes(2);
    expect(client.bgsave).toHaveBeenCalledTimes(1);
    expect(client.del).toHaveBeenCalledTimes(1);
  });

  it('fails closed on the MISCONF write refusal', async () => {
    const client = fakeClient({
      set: jest.fn(async () => {
        throw new Error('MISCONF Redis is configured to save RDB snapshots');
      }) as RedisPersistenceClient['set'],
    });
    await expect(assertRedisPersistence(client, { pollIntervalMs: 0 })).rejects.toThrow(
      /writability probe failed.*MISCONF/iu,
    );
  });

  it('fails when the forced snapshot exposes a persistence error', async () => {
    const client = fakeClient({
      info: jest.fn(async () =>
        'rdb_bgsave_in_progress:0\r\nrdb_last_bgsave_status:err\r\nrdb_saves_consecutive_failures:1\r\n'),
    });
    await expect(assertRedisPersistence(client, { pollIntervalMs: 0 })).rejects.toThrow(
      /snapshot failed/iu,
    );
  });
});
