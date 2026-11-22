import { loadDocumentCorpus } from '../src/services/editorial/qualityLab/documentCorpus';
import { loadBenchmarkBaseline, validateCorpus } from '../src/services/editorial/qualityLab/corpusLoader';

async function main() {
  const [corpus, baseline] = await Promise.all([validateCorpus(), loadBenchmarkBaseline()]);
  if (!corpus.valid || baseline.suiteKey !== corpus.suiteKey) throw new Error('EDITORIAL_BENCHMARK_INVALID');
  const documents = await loadDocumentCorpus();
  process.stdout.write(`${JSON.stringify({ corpus, baseline, documents: { suiteKey: documents.manifest.suiteKey, suiteVersion: documents.manifest.suiteVersion, caseCount: documents.cases.length } }, null, 2)}\n`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
