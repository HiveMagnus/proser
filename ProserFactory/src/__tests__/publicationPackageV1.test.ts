import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createPublicationPackage } from '@/services/publicationPackageService';

describe('publication package v1', () => {
  let directory: string;
  const prior = process.env.PUBLICATION_DIR;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'proser-publication-'));
    process.env.PUBLICATION_DIR = directory;
  });

  afterEach(async () => {
    if (prior === undefined) delete process.env.PUBLICATION_DIR;
    else process.env.PUBLICATION_DIR = prior;
    await rm(directory, { recursive: true, force: true });
  });

  it('writes validated Markdown, EPUB, DOCX, HTML, metadata, and cover artifacts', async () => {
    const book = {
      title: 'A Map of Ash', summary: 'A cartographer finds an erased country.', genre: 'fantasy',
      acts: [{ actNumber: 1, title: 'The Absence', chapters: [{ chapterNumber: 1, title: 'Blank Coast', scenes: [{ sceneNumber: 1, prose: `${'The coast refused the ink. '.repeat(70)}\n\nMira folded the impossible map.` }] }] }],
    };
    const result = await createPublicationPackage('00000000-0000-0000-0000-000000000001', 'revision-1', book, { author: 'Test Author', audience: 'adult' });
    expect(result.validation.pass).toBe(true);
    expect(result.manifest.artifacts.map((artifact) => artifact.format)).toEqual(['markdown', 'epub', 'docx', 'html', 'metadata', 'cover-spec', 'front-matter', 'back-matter']);
    for (const artifact of result.manifest.artifacts) {
      const bytes = await readFile(path.join(result.directory, artifact.filename));
      expect(bytes.byteLength).toBe(artifact.bytes);
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
