const assert = require('node:assert/strict');
const test = require('node:test');
const { validateIsolatedTestServices } = require('./require-isolated-test-services.cjs');
const fixture = { DATABASE_URL: 'postgresql://fixture:secret@127.0.0.1:55441/proser_canvas_fixture', REDIS_URL: 'redis://127.0.0.1:56441/9' };
test('explicit fixture services are accepted', () => assert.doesNotThrow(() => validateIsolatedTestServices(fixture)));
test('missing, production and ambiguous service selections fail before test setup', () => {
  for (const environment of [
    {}, { ...fixture, DATABASE_URL: undefined }, { ...fixture, REDIS_URL: undefined },
    { ...fixture, DATABASE_URL: fixture.DATABASE_URL.replace('55441', '5432') },
    { ...fixture, DATABASE_URL: fixture.DATABASE_URL.replace('proser_canvas_fixture', 'proser') },
    { ...fixture, DATABASE_URL: fixture.DATABASE_URL.replace('127.0.0.1', 'proser') },
    { ...fixture, REDIS_URL: 'redis://127.0.0.1:6379' },
  ]) assert.throws(() => validateIsolatedTestServices(environment), /isolated/);
});
