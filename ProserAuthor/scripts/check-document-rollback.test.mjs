import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('./check-document-rollback.mjs', import.meta.url));
const run = (input) =>
  spawnSync(process.execPath, [script], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
test('allows an incompatible checkpoint only with explicit inactive authority', () => {
  assert.equal(
    run({
      success: true,
      data: { components: { documentSchema: 'disabled', documentEnforcement: 'disabled' } },
    }).status,
    0,
  );
});
test('active, unavailable, incomplete and untrusted responses fail closed', () => {
  for (const [schema, enforcement] of [
    ['ready', 'ready'],
    ['disabled', 'ready'],
    ['unavailable', 'disabled'],
    ['disabled', 'unavailable'],
  ])
    assert.notEqual(
      run({
        success: true,
        data: { components: { documentSchema: schema, documentEnforcement: enforcement } },
      }).status,
      0,
    );
  for (const input of [
    '',
    '{',
    {},
    {
      success: false,
      data: { components: { documentSchema: 'disabled', documentEnforcement: 'disabled' } },
    },
    { success: true, data: { components: {} } },
  ])
    assert.notEqual(run(input).status, 0);
});
