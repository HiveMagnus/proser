import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { compileProject } from './build.mjs';

test('compiled static/dynamic imports and declarations resolve without rewriting manuscript strings', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'proser-build-fixture-'));
  try {
    await mkdir(path.join(root, 'src/lib'), { recursive: true });
    await mkdir(path.join(root, 'src/nested'), { recursive: true });
    const config = path.join(root, 'tsconfig.json');
    await writeFile(config, JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'commonjs', strict: true, rootDir: 'src', outDir: 'dist', paths: { '@/*': ['./src/*'] }, declaration: true, declarationMap: true, sourceMap: true, types: [], skipLibCheck: true }, include: ['src/**/*.ts'] }));
    await writeFile(path.join(root, 'src/lib/value.ts'), 'export const value = 42;');
    const entry = path.join(root, 'src/nested/entry.ts');
    await writeFile(entry, `import { value } from '@/lib/value';
export { value as reference } from '@/lib/value';
export type ValueModule = typeof import('@/lib/value');
export const prose = '@/literal/manuscript';
export function answer() { return value; }
export async function load() { return (await import('@/lib/value')).value; }
`);
    assert.equal(compileProject(config), true);
    const file = path.join(root, 'dist/nested/entry.js');
    const require = createRequire(import.meta.url); const emitted = require(file);
    assert.equal(emitted.answer(), 42); assert.equal(emitted.reference, 42);
    assert.equal(await emitted.load(), 42); assert.equal(emitted.prose, '@/literal/manuscript');
    const declaration = await readFile(path.join(root, 'dist/nested/entry.d.ts'), 'utf8');
    assert.ok(declaration.includes('../lib/value')); assert.ok(!declaration.includes('@/lib/value'));
    const sourceMap = JSON.parse(await readFile(`${file}.map`, 'utf8'));
    assert.deepEqual(sourceMap.sources, ['../../src/nested/entry.ts']); assert.ok(sourceMap.mappings.length);
    const before = await readFile(file, 'utf8');
    await writeFile(entry, `export const invalid: number = 'wrong type';`);
    assert.equal(compileProject(config), false);
    assert.equal(await readFile(file, 'utf8'), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
