import { resolveDatabasePoolSize } from '../lib/database';

describe('database connection configuration', () => {
  it('bounds the PostgreSQL connection pool', () => {
    expect(resolveDatabasePoolSize(undefined)).toBe(20);
    expect(resolveDatabasePoolSize('45')).toBe(45);
    expect(resolveDatabasePoolSize('1')).toBe(2);
    expect(resolveDatabasePoolSize('999')).toBe(100);
    expect(resolveDatabasePoolSize('invalid')).toBe(20);
  });
});
