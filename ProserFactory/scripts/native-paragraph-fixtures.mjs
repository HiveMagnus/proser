#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { exportDocx, defaultLayout } = require('@hivemagnus/canvas-word-codec');
const target = process.argv[2];
if (!target || !path.isAbsolute(target)) throw new Error('Supply an isolated absolute fixture directory.');
const paragraph = (id, text) => ({ type: 'paragraph', id, style: {}, runs: [{ id: `${id}-run`, text, style: {} }] });
const record = (kind, targetBlockIds) => ({ id: 'review', kind, authorName: 'Fixture reviewer', createdAt: '2026-01-02T03:04:05.000Z', status: 'pending', targetRunIds: [], targetBlockIds });
await mkdir(target, { recursive: true });
for (const kind of ['paragraphFormat', 'paragraphSplit', 'paragraphJoin']) {
  const left = paragraph('left', 'Left paragraph.'); const right = paragraph('right', 'Right paragraph.');
  const document = { schemaVersion: 1, blocks: [left, right], changes: [record(kind, kind === 'paragraphFormat' ? ['left'] : ['left', 'right'])], comments: [], layout: defaultLayout() };
  document.layout.font = 'Liberation Serif';
  if (kind === 'paragraphFormat') {
    left.style = { alignment: 'center', indent: 24, firstLineIndent: 12, before: 6, after: 4, lineSpacing: 1.5, keepWithNext: true, pageBreakBefore: false, list: 'bullet' };
    document.changes[0].beforeParagraphStyle = { alignment: 'left', indent: 0, firstLineIndent: 0, before: 0, after: 8, lineSpacing: 1, keepWithNext: false, pageBreakBefore: false, list: 'number' };
    document.changes[0].afterParagraphStyle = { ...left.style };
  } else left.boundaryChangeId = 'review';
  for (const mode of ['final', 'original', 'retain-review']) await writeFile(path.join(target, `${kind}-${mode}.docx`), await exportDocx(document, mode));
}
