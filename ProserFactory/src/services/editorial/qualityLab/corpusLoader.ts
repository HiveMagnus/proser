import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadDocumentCorpus } from './documentCorpus';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

interface ManifestCase {
  id: string;
  caseVersion: string;
  level: string;
  fixture: string;
  expected: string;
  tags: string[];
}
interface Manifest {
  suiteKey: string;
  suiteVersion: string;
  cases: ManifestCase[];
}
export interface PublicCorpusCase {
  id: string;
  suiteKey: string;
  suiteVersion: string;
  caseVersion: string;
  level: string;
  tags: string[];
  input: {
    name: string;
    original: string;
    candidate: string;
    protectedElements: string[];
    references: string[];
  };
  inputHash: string;
  expectedHash: string;
}
export interface HiddenExpected {
  expectedVerdict: 'candidate_wins' | 'original_wins' | 'no_clear_winner';
  hardInvariantPass: boolean;
}

const root = path.resolve(process.cwd(), 'evaluation');
const manifestPath = path.join(root, 'manifests', 'editorial-v1.json');
const baselinePath = path.join(root, 'baselines', 'editorial-deterministic-1.0.0.json');

async function jsonFile<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

export async function loadCorpus(): Promise<{ manifest: Manifest; cases: PublicCorpusCase[] }> {
  const manifest = await jsonFile<Manifest>(manifestPath);
  if (!manifest.suiteKey || !manifest.suiteVersion || !manifest.cases.length) throw new Error('EDITORIAL_BENCHMARK_INVALID');
  const cases: PublicCorpusCase[] = [];
  for (const item of manifest.cases) {
    const inputPath = path.resolve(path.dirname(manifestPath), item.fixture);
    const expectedPath = path.resolve(path.dirname(manifestPath), item.expected);
    if (!inputPath.startsWith(root) || !expectedPath.startsWith(path.join(root, 'hidden'))) throw new Error('EDITORIAL_BENCHMARK_INVALID');
    const input = await jsonFile<PublicCorpusCase['input']>(inputPath);
    const expected = await jsonFile<HiddenExpected>(expectedPath);
    cases.push({
      id: item.id, suiteKey: manifest.suiteKey, suiteVersion: manifest.suiteVersion,
      caseVersion: item.caseVersion, level: item.level, tags: item.tags,
      input, inputHash: hash(input), expectedHash: hash(expected),
    });
  }
  if (new Set(cases.map((item) => item.id)).size !== cases.length) throw new Error('Duplicate Quality Lab case ID');
  return { manifest, cases };
}

/** Scorer-only hidden data path. Never include this value in generator or judge input. */
export async function loadHiddenExpected(caseId: string): Promise<HiddenExpected> {
  const manifest = await jsonFile<Manifest>(manifestPath);
  const item = manifest.cases.find((entry) => entry.id === caseId);
  if (!item) throw new Error('EDITORIAL_BENCHMARK_INVALID');
  const expectedPath = path.resolve(path.dirname(manifestPath), item.expected);
  if (!expectedPath.startsWith(path.join(root, 'hidden'))) throw new Error('EDITORIAL_BENCHMARK_INVALID');
  return jsonFile<HiddenExpected>(expectedPath);
}

export async function validateCorpus(): Promise<{ valid: boolean; suiteKey: string; suiteVersion: string; caseCount: number; inputHash: string }> {
  const loaded = await loadCorpus();
  await loadDocumentCorpus();
  return {
    valid: true, suiteKey: loaded.manifest.suiteKey, suiteVersion: loaded.manifest.suiteVersion,
    caseCount: loaded.cases.length, inputHash: hash(loaded.cases.map((item) => item.inputHash)),
  };
}

export async function loadBenchmarkBaseline(): Promise<{
  suiteKey: string;
  suiteVersion: string;
  minimums: Record<string, number>;
}> {
  return jsonFile(baselinePath);
}
