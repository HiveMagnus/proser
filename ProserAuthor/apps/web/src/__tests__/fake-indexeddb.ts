/** A minimal in-memory IndexedDB for keyPath object stores, enough for the draft journals. */
export function installFakeIndexedDB() {
  const databases = new Map<string, Map<string, Map<string, unknown>>>();
  const later = (callback: () => void) => queueMicrotask(callback);
  const request = <T>(compute: () => T) => {
    const req: {
      result?: T;
      error: unknown;
      onsuccess?: (() => void) | null;
      onerror?: (() => void) | null;
    } = { error: null };
    later(() => {
      req.result = compute();
      req.onsuccess?.();
    });
    return req;
  };
  const fake = {
    open(name: string) {
      const req: Record<string, unknown> & {
        onupgradeneeded?: () => void;
        onsuccess?: () => void;
      } = { error: null };
      later(() => {
        const fresh = !databases.has(name);
        if (fresh) databases.set(name, new Map());
        const stores = databases.get(name)!;
        const database = {
          createObjectStore: (store: string) => stores.set(store, new Map()),
          close: () => undefined,
          transaction: (store: string) => {
            const transaction: Record<string, unknown> & { oncomplete?: () => void } = {};
            const table = stores.get(store)!;
            const finish = <T>(compute: () => T) => {
              const req = request(compute);
              later(() => later(() => transaction.oncomplete?.()));
              return req;
            };
            transaction.objectStore = () => ({
              get: (key: string) => finish(() => structuredClone(table.get(key))),
              getAll: () => finish(() => [...table.values()].map((row) => structuredClone(row))),
              put: (row: { key: string }) =>
                finish(() => (table.set(row.key, structuredClone(row)), row.key)),
              delete: (key: string) => finish(() => (table.delete(key), undefined)),
            });
            return transaction;
          },
        };
        req.result = database;
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
    deleteDatabase(name: string) {
      return request(() => {
        databases.delete(name);
        return undefined;
      });
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: fake });
  return databases;
}
