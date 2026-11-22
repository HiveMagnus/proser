import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { documentFromText, type DocumentParagraph } from '../src/documents/model';
import { publicationDocx } from '../src/documents/publicationDocx';
import {
  publicationEpub,
  publicationPdf,
  type PublicationInput,
} from '../src/documents/publicationRender';
const target = process.argv[2];
if (!target || !path.isAbsolute(target))
  throw new Error('Supply an isolated absolute fixture directory.');
const paragraph = (id: string, text: string): DocumentParagraph => ({
  type: 'paragraph',
  id,
  style: {},
  runs: [{ id: id + '-r', text, style: {} }],
});
async function main() {
  await mkdir(target, { recursive: true });
  const first = documentFromText(
    'The tide grows.\n\nSecond paragraph 😀 é.',
    (() => {
      let index = 0;
      return () => `first-${++index}`;
    })(),
  );
  const second = documentFromText(
    'Other chapter text.\n\nSecond numbered item.',
    (() => {
      let index = 0;
      return () => `second-${++index}`;
    })(),
  );
  first.layout.font = 'Liberation Serif';
  first.layout.header = [paragraph('header1', 'First chapter header')];
  first.layout.footer = [paragraph('footer1', 'Footer story')];
  second.layout.font = 'Liberation Mono';
  second.layout.header = [paragraph('header2', 'Second chapter header')];
  second.layout.margins = [80, 90, 80, 90];
  if (first.blocks[0].type !== 'paragraph') throw new Error('fixture');
  const block = first.blocks[0];
  block.runs = [
    { id: 'old-run', text: 'The storm grows.', style: { italic: true }, changeId: 'old-change' },
    { id: 'new-run', text: 'The tide grows.', style: { bold: true }, changeId: 'new-change' },
  ];
  first.changes = [
    {
      id: 'old-change',
      kind: 'deletion',
      authorId: 1,
      authorName: 'Editor',
      createdAt: '2026-01-01T00:00:00Z',
      status: 'pending',
      origin: 'ai',
      targetRunIds: ['old-run'],
    },
    {
      id: 'new-change',
      kind: 'insertion',
      authorId: 1,
      authorName: 'Editor',
      createdAt: '2026-01-01T00:00:00Z',
      status: 'pending',
      origin: 'ai',
      targetRunIds: ['new-run'],
    },
  ];
  first.comments = [
    {
      id: 'comment',
      authorId: 1,
      authorName: 'Editor',
      createdAt: '2026-01-01T00:00:00Z',
      text: 'Review the weather.',
      resolved: false,
      anchors: [{ blockId: block.id, runId: 'new-run', start: 0, end: 3, sourceText: 'The' }],
    },
  ];
  for (const value of second.blocks) if (value.type === 'paragraph') value.style.list = 'number';
  const input: PublicationInput = {
    title: 'Multi chapter fixture',
    author: 'Fixture Author',
    revisionId: '11111111-1111-4111-8111-111111111111',
    sections: [
      { id: 's1', title: 'First chapter', document: first },
      { id: 's2', title: 'Second chapter', document: second },
    ],
    assets: new Map(),
  };
  for (const mode of ['final', 'original', 'retain-review'] as const) {
    await writeFile(path.join(target, `${mode}.docx`), await publicationDocx(input, mode));
    await writeFile(path.join(target, `${mode}.epub`), await publicationEpub(input, mode));
    await writeFile(path.join(target, `${mode}.pdf`), (await publicationPdf(input, mode)).bytes);
  }
}
void main();
