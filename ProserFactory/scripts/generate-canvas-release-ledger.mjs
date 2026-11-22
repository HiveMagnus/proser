#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { installedCanvasPackages } from '../../scripts/check-canvas-shared-packages.mjs';

const repository = new URL('../../', import.meta.url).pathname;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const lock = await readJson(path.join(repository, 'ProserFactory/package-lock.json'));
const installed = await installedCanvasPackages();
const staging = await mkdtemp(path.join(os.tmpdir(), 'proser-shared-canvas-release-'));
const id = (name, version) => `pkg:npm/${name}@${version}`;
try {
  const distributions = [];
  const components = new Map();
  const dependencies = new Map();
  const add = (name, value) => {
    const ref = id(name, value.version);
    components.set(ref, {
      type: 'library', 'bom-ref': ref, name, version: value.version,
      purl: `pkg:npm/${name.replace('@', '%40')}@${value.version}`,
      licenses: [{ license: { id: value.license ?? 'MIT' } }],
      ...(value.integrity ? { properties: [{ name: 'npm:integrity', value: value.integrity }] } : {}),
      ...(value.resolved ? { externalReferences: [{ type: 'distribution', url: value.resolved }] } : {}),
    });
    return ref;
  };
  const closure = (name, fromKey = '') => {
    let parent = fromKey;
    let key;
    while (true) {
      const candidate = `${parent ? parent + '/' : ''}node_modules/${name}`;
      if (lock.packages[candidate]) { key = candidate; break; }
      if (!parent) throw new Error(`Missing exact runtime dependency ${name}`);
      const boundary = parent.lastIndexOf('/node_modules/');
      parent = boundary < 0 ? '' : parent.slice(0, boundary);
    }
    const value = lock.packages[key];
    const ref = add(name, value);
    if (dependencies.has(ref)) return ref;
    dependencies.set(ref, []);
    dependencies.set(ref, Object.keys(value.dependencies ?? {}).map(child => closure(child, key)));
    return ref;
  };
  for (const item of installed) {
    const pack = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', staging], { cwd: item.directory, encoding: 'utf8' }))[0];
    const bytes = await readFile(path.join(staging, pack.filename));
    distributions.push({ name: pack.name, version: pack.version, filename: pack.filename, integrity: pack.integrity, sha256: sha(bytes), files: pack.files.map(file => ({ path: file.path, size: file.size })).sort((a, b) => a.path.localeCompare(b.path)) });
    if (item.kind === 'codec') closure(item.manifest.name);
    else {
      const ref = add(item.manifest.name, item.manifest);
      const helpers = [];
      for (const filename of await readdir(path.join(item.directory, 'notices'))) {
        const match = /^(rolldown|vite-plugin-css-injected-by-js)-(\d+\.\d+\.\d+)\.LICENSE$/.exec(filename);
        if (!match) continue;
        const helper = add(match[1], { version: match[2], license: 'MIT' });
        components.get(helper).properties = [
          { name: 'proser:distribution', value: 'embedded browser build helper' },
          { name: 'proser:license-notice-sha256', value: sha(await readFile(path.join(item.directory, 'notices', filename))) },
        ];
        dependencies.set(helper, []);
        helpers.push(helper);
      }
      if (helpers.length !== 2) throw new Error('Expected the two exact embedded helper notices.');
      dependencies.set(ref, helpers);
    }
  }
  const engine = installed.find(item => item.kind === 'engine');
  const build = await readJson(path.join(engine.directory, 'dist/build-manifest.json'));
  const evidence = {
    schemaVersion: 2, sourceRepository: 'https://github.com/ChefTaco/canvas-word',
    distributions, coreBundledModules: build.outputs,
    preservedEditorPullRequests: [1495, 1496, 1505, 1506, 1508, 1509],
    historicalOwnedForkLedger: 'docs/history/canvas-owned-forks-20261108',
    wordAcceptance: 'unverified', physicalDeviceAcceptance: 'incomplete', performanceCertification: 'deferred-R6',
  };
  const sbom = {
    bomFormat: 'CycloneDX', specVersion: '1.6', version: 1,
    metadata: { tools: { components: [{ type: 'application', name: 'proser-shared-canvas-release-ledger', version: '2.0.0' }] } },
    components: [...components.values()],
    dependencies: [...dependencies].map(([ref, dependsOn]) => ({ ref, dependsOn })),
    properties: [{ name: 'proser:release-evidence-sha256', value: sha(JSON.stringify(evidence)) }, { name: 'proser:engine-build-helpers', value: 'embedded in the verified single-file distribution; license notices shipped by canvas-word' }],
  };
  const destination = path.join(repository, 'ProserFactory/docs');
  const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
  if (output && !path.isAbsolute(output)) throw new Error('Release output must be absolute.');
  if (output) await mkdir(output, { recursive: true });
  for (const [name, value] of [['canvas-release-evidence.json', evidence], ['canvas-release-sbom.json', sbom]]) {
    const text = JSON.stringify(value, null, 2) + '\n';
    const target = path.join(destination, name);
    if (process.argv.includes('--check')) {
      if (await readFile(target, 'utf8').catch(() => '') !== text) throw new Error(`Stale exact shared package ledger ${name}`);
    } else await writeFile(target, text);
    if (output) await writeFile(path.join(output, name), text);
  }
  if (output) for (const distribution of distributions) await writeFile(path.join(output, distribution.filename), await readFile(path.join(staging, distribution.filename)));
  console.log(`Verified shared distributions: ${distributions.map(item => `${item.name}@${item.version}`).join(', ')}`);
} finally { await rm(staging, { recursive: true, force: true }); }
