import { identityAcceptance } from './identity-acceptance';
import { Previewer } from '@hivemagnus/canvas-word-engine/testing';
import { mergeOption } from '@hivemagnus/canvas-word-engine/testing';
import { HyperlinkParticle } from '@hivemagnus/canvas-word-engine/testing';
import type { Draw } from '@hivemagnus/canvas-word-engine/testing';
import type { IElementPosition } from '@hivemagnus/canvas-word-engine/testing';
import CanvasEditor, {
  PageMode,
  TitleLevel,
  ListType,
  EditorZone,
} from '@hivemagnus/canvas-word-engine';
import {
  documentFromText,
  regenerateDocumentText,
  projectDocument,
  canonicalDocument,
  type ProserDocument,
} from '../src/document-model';
import {
  documentToCanvas,
  canvasToDocument,
  canvasTitleOptions,
  ownedCanvasImageSource,
} from '../src/canvas-adapter';
import { canvasSelection } from '../src/document-selection';
import { createElement, useState } from 'react';
import { CanvasDocumentEditor } from '../src/components/canvas-document-editor';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { SemanticDocument } from '../src/components/semantic-document';
import type { DocumentSelection } from '../src/document-selection';
import {
  writeQuickDraftIntent,
  readQuickDraftIntent,
  deleteQuickDraftIntent,
  type QuickDraftIntent,
} from '../../../apps/web/src/lib/document-quick-drafts';
import {
  writeDocumentCompareIntent,
  readDocumentCompareIntent,
  deleteDocumentCompareIntent,
  type DocumentCompareIntent,
} from '../../../apps/web/src/lib/document-review-journal';
import {
  writeDocumentPassageDraft,
  readDocumentPassageDraft,
  deleteDocumentPassageDraft,
  type DocumentPassageDraft,
} from '../../../apps/web/src/lib/document-passage-journal';
import { passageCommit } from '../../../apps/web/src/lib/document-passage-editing';
let sequence = 0;
const id = () => `browser-${++sequence}`;
const document = documentFromText('Hello 😀 e\u0301 world\n\nSecond paragraph\nsoft break\n\n', id);
const first = document.blocks[0];
if (first?.type !== 'paragraph') throw new Error('Invalid fixture');
first.runs[0]!.style = {
  font: 'Georgia',
  size: 18,
  bold: true,
  color: '#123456',
  hyperlink: 'https://example.com/owned-link',
};
document.layout.header = [
  {
    type: 'paragraph',
    id: id(),
    style: {},
    runs: [{ id: id(), text: 'Fixture header', style: { italic: true } }],
  },
];
document.blocks.push({
  type: 'table',
  id: id(),
  widths: [160, 160],
  rows: [
    {
      id: id(),
      cells: [
        {
          id: id(),
          paragraphs: [
            {
              type: 'paragraph',
              id: id(),
              style: {},
              runs: [{ id: id(), text: 'Left', style: { italic: true } }],
            },
          ],
        },
        {
          id: id(),
          paragraphs: [
            {
              type: 'paragraph',
              id: id(),
              style: {},
              runs: [{ id: id(), text: 'Right', style: {} }],
            },
          ],
        },
      ],
    },
  ],
});
let editor: CanvasEditor | undefined;
const host = window.document.getElementById('document') as HTMLDivElement;
const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message);
};
async function paragraphLayoutProof() {
  const options = {
    width: 500,
    height: 500,
    margins: [40, 40, 40, 40] as [number, number, number, number],
    defaultSize: 16,
    header: { disabled: true },
    footer: { disabled: true },
  };
  const locate = (query: string) => {
    const range = editor!.command.getKeywordRangeList(query)[0];
    assert(Boolean(range), 'Layout keyword missing ' + query);
    editor!.command.executeSetPositionContext(range!);
    editor!.command.executeSetRange(range!.startIndex, range!.endIndex);
    const context = editor!.command.getRangeContext()!;
    assert(Boolean(context.rangeRects[0]), 'Layout rectangle missing ' + query);
    return context;
  };
  const rect = (query: string) => locate(query).rangeRects[0]!;
  const source = documentFromText(
    'First ' +
      Array.from({ length: 40 }, (_, n) => 'token' + String(n).padStart(2, '0')).join(' ') +
      ' tail\n\nSecond marker',
    id,
  );
  const first = source.blocks[0];
  const second = source.blocks[1];
  if (first?.type !== 'paragraph' || second?.type !== 'paragraph')
    throw new Error('Layout fixture');
  editor = new CanvasEditor(host, documentToCanvas(source), options);
  const baselineFirst = rect('First');
  editor.destroy();
  first.style = { before: 12, after: 18, indent: 40, firstLineIndent: 20 };
  second.style = { before: 7 };
  editor = new CanvasEditor(host, documentToCanvas(source), options);
  editor.command.executeSetRange(1, 1);
  const initial = rect('First');
  assert(
    Math.abs(initial.x - 100) < 1 && Math.abs(initial.y - baselineFirst.y - 12) < 1,
    'First-line indentation/before spacing incorrect ' + canonicalDocument(initial),
  );
  editor.command.executeSelectAll();
  const continuation = editor.command
    .getRangeContext()!
    .rangeRects.find((rectangle) => Math.abs(rectangle.y - initial.y - initial.height) < 1)!;
  assert(
    Boolean(continuation) && Math.abs(continuation.x - 80) < 1,
    'Continuation row indentation differs from paragraph inset ' + canonicalDocument(continuation),
  );
  const tail = rect('tail');
  const following = rect('Second');
  assert(
    Math.abs(following.y - tail.y - tail.height - 18) < 1,
    'Paragraph after/before spacing overlaps glyph rows ' + canonicalDocument({ tail, following }),
  );
  assert(
    canonicalDocument(
      canvasToDocument(editor.command.getValue({ extraPickAttrs: ['id'] }).data, source, id),
    ) === canonicalDocument(source),
    'Rendered paragraph properties changed stored defaults',
  );
  const selection = editor.command.getKeywordRangeList('Second')[0]!;
  editor.command.executeSetPositionContext(selection);
  editor.command.executeSetRange(selection.startIndex, selection.endIndex);
  editor.command.executeInsertElementList([{ value: 'Replaced' }]);
  const edited = canvasToDocument(
    editor.command.getValue({ extraPickAttrs: ['id'] }).data,
    source,
    id,
  );
  assert(
    projectDocument(edited).text === projectDocument(source).text.replace('Second', 'Replaced'),
    'Paragraph layout changed native typing',
  );
  editor.command.executeUndo();
  assert(
    canonicalDocument(
      canvasToDocument(editor.command.getValue({ extraPickAttrs: ['id'] }).data, source, id),
    ) === canonicalDocument(source),
    'Paragraph layout undo lost canonical identities',
  );
  editor.destroy();
  const soft = documentFromText('First\nsoft\nLast\n\nFollowing', id);
  const softFirst = soft.blocks[0];
  const softNext = soft.blocks[1];
  if (softFirst?.type !== 'paragraph' || softNext?.type !== 'paragraph')
    throw new Error('Soft fixture');
  softFirst.style = { before: 12, after: 18, indent: 40, firstLineIndent: 20 };
  softNext.style = { before: 7 };
  editor = new CanvasEditor(host, documentToCanvas(soft), options);
  const softRect = rect('soft');
  const lastRect = rect('Last');
  assert(
    Math.abs(softRect.x - 80) < 1 && Math.abs(lastRect.y - softRect.y - softRect.height) < 1,
    'Soft breaks repeated paragraph indentation/spacing',
  );
  editor.destroy();
  const joined = documentFromText('Left\n\nRight', id);
  const left = joined.blocks[0];
  const right = joined.blocks[1];
  if (left?.type !== 'paragraph' || right?.type !== 'paragraph') throw new Error('Join fixture');
  left.style = { before: 12, after: 18, indent: 40 };
  right.style = { before: 90, indent: 100 };
  left.boundaryChangeId = 'layout-join';
  joined.changes.push({
    id: 'layout-join',
    kind: 'paragraphJoin',
    targetRunIds: [],
    targetBlockIds: [left.id, right.id],
    authorId: 7,
    authorName: 'Writer',
    origin: 'manual',
    createdAt: '2026-10-05T00:00:00Z',
    status: 'pending',
  });
  editor = new CanvasEditor(host, documentToCanvas(joined), options);
  const leftRect = rect('Left');
  const rightRect = rect('Right');
  assert(
    leftRect.y === rightRect.y && Math.abs(leftRect.x - 80) < 1,
    'Pending joined physical paragraphs received separate layout',
  );
  assert(
    canonicalDocument(
      canvasToDocument(editor.command.getValue({ extraPickAttrs: ['id'] }).data, joined, id),
    ) === canonicalDocument(joined),
    'Logical layout lost physical paragraph styles',
  );
  editor.destroy();
  editor = new CanvasEditor(host, documentToCanvas(joined, 'original'), options);
  assert(
    rect('Right').y > rect('Left').y + 90,
    'Original join view did not restore paragraph spacing',
  );
  editor.destroy();
  const listSource = documentFromText('ListFirst', id);
  const listParagraph = listSource.blocks[0];
  if (listParagraph?.type !== 'paragraph') throw new Error('List fixture');
  listParagraph.style = { list: 'bullet' };
  editor = new CanvasEditor(host, documentToCanvas(listSource), options);
  const listBefore = rect('ListFirst');
  editor.destroy();
  listParagraph.style = { list: 'bullet', indent: 25, firstLineIndent: 10 };
  editor = new CanvasEditor(host, documentToCanvas(listSource), options);
  assert(
    Math.abs(rect('ListFirst').x - listBefore.x - 35) < 1,
    `List marker inset displaced paragraph indentation: ${listBefore.x} -> ${rect('ListFirst').x}`,
  );
  editor.destroy();
  const hanging = documentFromText('Hanging ' + 'word '.repeat(40), id);
  const hangingParagraph = hanging.blocks[0];
  if (hangingParagraph?.type !== 'paragraph') throw new Error('Hanging fixture');
  hangingParagraph.style = { indent: 40, firstLineIndent: -20 };
  editor = new CanvasEditor(host, documentToCanvas(hanging), options);
  assert(
    Math.abs(rect('Hanging').x - 60) < 1,
    'Negative first-line indentation clipped the paragraph',
  );
  editor.destroy();
  const tableSource = documentFromText('Body', id);
  const tableParagraphs = documentFromText('CellFirst\n\nCellSecond', id).blocks;
  if (tableParagraphs.some((p) => p.type !== 'paragraph')) throw new Error('Table fixture');
  tableSource.blocks.push({
    type: 'table',
    id: id(),
    widths: [300],
    rows: [
      {
        id: id(),
        cells: [
          {
            id: id(),
            paragraphs: tableParagraphs as import('../src/document-model').DocumentParagraph[],
          },
        ],
      },
    ],
  });
  editor = new CanvasEditor(host, documentToCanvas(tableSource), options);
  const cellBefore = rect('CellFirst');
  editor.destroy();
  const cellFirst = tableParagraphs[0];
  const cellSecond = tableParagraphs[1];
  if (cellFirst?.type !== 'paragraph' || cellSecond?.type !== 'paragraph')
    throw new Error('Cell fixture');
  cellFirst.style = { indent: 25, firstLineIndent: 10, before: 9, after: 11 };
  cellSecond.style = { before: 5 };
  editor = new CanvasEditor(host, documentToCanvas(tableSource), options);
  const cellStyled = rect('CellFirst');
  const cellFollowing = rect('CellSecond');
  assert(
    Math.abs(cellStyled.x - cellBefore.x - 35) < 1 && Math.abs(cellStyled.y - cellBefore.y - 9) < 1,
    'Table-cell paragraph inset/before spacing incorrect',
  );
  assert(
    Math.abs(cellFollowing.y - cellStyled.y - cellStyled.height - 11) < 1,
    'Table-cell after spacing missing',
  );
  assert(
    canonicalDocument(
      canvasToDocument(editor.command.getValue({ extraPickAttrs: ['id'] }).data, tableSource, id),
    ) === canonicalDocument(tableSource),
    'Table layout changed canonical widths/identities',
  );
  editor.destroy();
  tableSource.layout = { ...tableSource.layout, width: 500, margins: [40, 40, 40, 40] };
  const largeTable = tableSource.blocks[1];
  if (largeTable?.type !== 'table') throw new Error('Large table fixture');
  largeTable.widths = [900];
  editor = new CanvasEditor(host, documentToCanvas(tableSource), options);
  assert(
    canonicalDocument(
      canvasToDocument(editor.command.getValue({ extraPickAttrs: ['id'] }).data, tableSource, id),
    ) === canonicalDocument(tableSource),
    'Visual table fitting changed original source widths',
  );
  editor.destroy();
  const stories = documentFromText('Body', id);
  stories.layout.header = documentFromText('HeaderFirst\n\nHeaderSecond', id)
    .blocks as import('../src/document-model').DocumentParagraph[];
  stories.layout.footer = documentFromText('FooterFirst\n\nFooterSecond', id)
    .blocks as import('../src/document-model').DocumentParagraph[];
  for (const paragraphs of [stories.layout.header, stories.layout.footer]) {
    paragraphs[0]!.style = { indent: 25, firstLineIndent: 10, before: 9, after: 11 };
    paragraphs[1]!.style = { before: 5 };
  }
  editor = new CanvasEditor(host, documentToCanvas(stories), {
    ...options,
    header: { disabled: false },
    footer: { disabled: false },
  });
  for (const [zone, query] of [
    [EditorZone.HEADER, 'Header'],
    [EditorZone.FOOTER, 'Footer'],
  ] as const) {
    editor.command.executeSetZone(zone);
    const start = rect(query + 'First');
    const end = rect(query + 'Second');
    assert(
      Math.abs(start.x - 75) < 1 && Math.abs(end.y - start.y - start.height - 11) < 1,
      'Story paragraph layout differs from body ' + zone,
    );
  }
  editor.command.executeSetZone(EditorZone.MAIN);
  assert(
    canonicalDocument(
      canvasToDocument(editor.command.getValue({ extraPickAttrs: ['id'] }).data, stories, id),
    ) === canonicalDocument(stories),
    'Story layout changed stored documents',
  );
  editor.destroy();
  const pages = documentFromText('First\n\nSecond\n\nThird', id);
  const p1 = pages.blocks[0];
  const p2 = pages.blocks[1];
  if (p1?.type !== 'paragraph' || p2?.type !== 'paragraph') throw new Error('Page fixture');
  p1.style.pageBreakBefore = true;
  p2.style.pageBreakBefore = true;
  editor = new CanvasEditor(host, documentToCanvas(pages), { ...options, height: 300 });
  assert(
    locate('First').startPageNo === 0 &&
      locate('Second').startPageNo === 1 &&
      locate('Third').startPageNo === 1,
    'Page-break-before created a blank first page or failed to break ' +
      canonicalDocument({
        first: locate('First').startPageNo,
        second: locate('Second').startPageNo,
        third: locate('Third').startPageNo,
        count: host.querySelectorAll('canvas').length,
      }),
  );
  editor.destroy();
  const keep = documentFromText(
    'Filler ' + 'fillerword '.repeat(18) + 'tail\n\nHeading\n\nFollowing',
    id,
  );
  editor = new CanvasEditor(host, documentToCanvas(keep), options);
  const headingRect = rect('Heading');
  const pageHeight = headingRect.y + headingRect.height + options.margins[2] + 2;
  editor.destroy();
  editor = new CanvasEditor(host, documentToCanvas(keep), { ...options, height: pageHeight });
  assert(
    locate('Heading').startPageNo === 0 && locate('Following').startPageNo === 1,
    'Keep-next baseline fixture did not straddle page boundary',
  );
  editor.destroy();
  const heading = keep.blocks[1];
  if (heading?.type !== 'paragraph') throw new Error('Keep fixture');
  heading.style.keepWithNext = true;
  editor = new CanvasEditor(host, documentToCanvas(keep), { ...options, height: pageHeight });
  assert(
    locate('Heading').startPageNo === 1 && locate('Following').startPageNo === 1,
    'Keep-next left heading orphaned across pages',
  );
  editor.destroy();
}
async function run() {
  const unsafePopup = new HyperlinkParticle({
    getOptions: () => ({ defaultHyperlinkColor: '#0066ff' }),
    getContainer: () => host,
    getPageOffset: () => ({ x: 0, y: 0 }),
    getPageNo: () => 0,
  } as unknown as Draw);
  const originalOpen = window.open;
  const opened: Array<{ url: unknown; features: unknown }> = [];
  window.open = ((url: unknown, _target: unknown, features: unknown) => {
    opened.push({ url, features });
    return null;
  }) as typeof window.open;
  try {
    for (const url of [
      'javascript:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html,<script>bad</script>',
      'blob:https://example.org/id',
    ]) {
      unsafePopup.drawHyperlinkPopup({ value: 'Bad link', url }, {
        coordinate: { leftTop: [0, 0] },
        lineHeight: 16,
      } as IElementPosition);
      assert(
        Boolean(host.querySelector('a[aria-disabled="true"]')) &&
          !host.querySelector('a[aria-disabled="true"]')?.getAttribute('href'),
        'An unsafe raw hyperlink became navigable before canonical validation',
      );
      unsafePopup.openHyperlink({ value: 'Bad link', url });
    }
    assert(opened.length === 0, 'Unsafe hyperlink opened a native browsing context');
    unsafePopup.drawHyperlinkPopup({ value: 'Safe link', url: 'https://example.org/safe' }, {
      coordinate: { leftTop: [0, 0] },
      lineHeight: 16,
    } as IElementPosition);
    assert(
      host.querySelector('a')?.getAttribute('href') === 'https://example.org/safe' &&
        host.querySelector('a')?.getAttribute('rel') === 'noopener noreferrer',
      'Safe hyperlink popup lost its validated destination or opener protection',
    );
    unsafePopup.openHyperlink({ value: 'Safe link', url: 'https://example.org/safe' });
    assert(
      opened.length === 1 && opened[0]?.features === 'noopener,noreferrer',
      'Safe hyperlink navigation lost opener protection',
    );
  } finally {
    window.open = originalOpen;
  }
  const bareLink = documentFromText('Bare hyperlink', id);
  (bareLink.blocks[0] as import('../src/document-model').DocumentParagraph).runs[0]!.style = {
    hyperlink: 'https://example.org/retained',
  };
  editor = new CanvasEditor(host, documentToCanvas(bareLink));
  const bareSaved = canvasToDocument(
    editor.command.getValue({ extraPickAttrs: ['id'] }).data,
    bareLink,
    id,
  );
  assert(
    canonicalDocument(bareSaved.blocks) === canonicalDocument(bareLink.blocks),
    'Painting a hyperlink invented stored underline or color formatting',
  );
  editor.command.executeSetRange(0, 1);
  editor.command.executeUnderline();
  assert(
    canvasToDocument(editor.command.getValue({ extraPickAttrs: ['id'] }).data, bareLink, id)
      .blocks[0]?.type === 'paragraph',
    'Hyperlink formatting command lost its paragraph',
  );
  editor.destroy();

  const namedDocument = documentFromText('Inherited character style', id);
  const namedParagraph = namedDocument.blocks[0];
  if (namedParagraph?.type !== 'paragraph') throw new Error('Named fixture');
  namedParagraph.style = { name: 'chapter_style' };
  namedParagraph.runs[0]!.style = { characterStyleId: 'character_child', color: '#123456' };
  const definitions = {
    paragraph: {
      chapter_style: { name: 'chapter_style', heading: 2 as const, alignment: 'right' as const },
    },
    text: {
      chapter_style: { size: 22 },
      character_base: { font: 'Liberation Sans', italic: true },
      character_child: { characterStyleId: 'character_base', bold: true },
    },
    labels: { chapter_style: '日本語 Chapter', character_child: 'Emphasis' },
  };
  editor = new CanvasEditor(host, documentToCanvas(namedDocument, 'final', definitions));
  editor.command.executeSetRange(1, 1);
  assert(
    canonicalDocument(
      canvasToDocument(editor.command.getValue({ extraPickAttrs: ['id'] }).data, namedDocument, id),
    ) === canonicalDocument(namedDocument),
    'Native named style rendering materialized inherited defaults',
  );
  editor.command.executeSetRange(0, 8);
  editor.command.executeBold();
  const namedEdited = canvasToDocument(
    editor.command.getValue({ extraPickAttrs: ['id'] }).data,
    namedDocument,
    id,
  );
  const namedFirst = namedEdited.blocks[0];
  assert(
    namedFirst?.type === 'paragraph' &&
      namedFirst.style.name === 'chapter_style' &&
      namedFirst.runs.some(
        (run) => run.style.characterStyleId === 'character_child' && run.style.bold === false,
      ),
    'Native named style override lost canonical reference ' + canonicalDocument(namedEdited.blocks),
  );
  editor.destroy();
  await paragraphLayoutProof();
  const literalZero = documentFromText('A\u200bB\n\nZero \u200b width 😀 e\u0301', id);
  editor = new CanvasEditor(host, documentToCanvas(literalZero));
  editor.command.executeSetRange(1, 1);
  assert(
    canonicalDocument(
      canvasToDocument(editor.command.getValue({ extraPickAttrs: ['id'] }).data, literalZero, id),
    ) === canonicalDocument(literalZero),
    'Literal U+200B was lost or interpreted as a paragraph boundary',
  );
  const literalRanges = editor.command.getKeywordRangeList('A\u200bB');
  assert(literalRanges.length === 1, 'Literal U+200B search was not exact');
  editor.command.executeSetRange(literalRanges[0]!.startIndex, literalRanges[0]!.endIndex);
  const literalSelection = canvasSelection(editor.command, literalZero);
  assert(
    literalSelection?.targets[0]?.sourceText === 'A\u200bB' &&
      literalSelection.targets[0].from === 0 &&
      literalSelection.targets[0].to === 3,
    'Literal U+200B selection changed UTF-16 offsets',
  );
  editor.command.executeInsertElementList([{ value: 'C\u200bD' }]);
  const literalEdited = canvasToDocument(
    editor.command.getValue({ extraPickAttrs: ['id'] }).data,
    literalZero,
    id,
  );
  assert(
    projectDocument(literalEdited).text === 'C\u200bD\n\nZero \u200b width 😀 e\u0301',
    'Typing through a literal U+200B selection changed paragraph boundaries',
  );
  editor.command.executeUndo();
  const literalUndone = canvasToDocument(
    editor.command.getValue({ extraPickAttrs: ['id'] }).data,
    literalZero,
    id,
  );
  assert(
    canonicalDocument(literalUndone) === canonicalDocument(literalZero),
    `Undo did not retain literal U+200B: ${canonicalDocument(literalUndone)}`,
  );
  editor.destroy();
  const imageDocument = documentFromText('Before image', id);
  const imageParagraph = imageDocument.blocks[0];
  if (imageParagraph?.type !== 'paragraph') throw new Error('Image fixture');
  imageParagraph.runs.push({
    id: id(),
    text: '',
    style: {},
    inlineImage: {
      assetId: 1,
      sha256: 'a'.repeat(64),
      alt: 'Oversized asset',
      width: 2000,
      height: 1000,
    },
  });
  editor = new CanvasEditor(host, documentToCanvas(imageDocument), {
    width: 600,
    margins: [20, 20, 20, 20],
  });
  const fitted = canvasToDocument(
    editor.command.getValue({ extraPickAttrs: ['id'] }).data,
    imageDocument,
    id,
  );
  assert(
    canonicalDocument(fitted.blocks) === canonicalDocument(imageDocument.blocks),
    'Fitting an inline image changed immutable asset dimensions or identities',
  );
  editor.destroy();

  editor = new CanvasEditor(host, documentToCanvas(document), {
    defaultFont: 'Georgia',
    defaultSize: 16,
  });
  const serialized = editor.command.getValue({ extraPickAttrs: ['id'] }).data;
  const compactText = serialized.main.flatMap((element) => element.valueList ?? [element]);
  assert(
    compactText.filter((element) => !element.type || element.type === 'text').length < 40,
    'Externally owned runs expanded into serialized glyph records',
  );
  const saved = canvasToDocument(serialized, document, id);
  assert(
    projectDocument(saved).text === projectDocument(document).text,
    `Projection changed: ${JSON.stringify(projectDocument(saved).text)}`,
  );
  const originalTable = document.blocks.find((block) => block.type === 'table')!;
  const savedTable = saved.blocks.find((block) => block.type === 'table')!;
  assert(
    savedTable.id === originalTable.id &&
      canonicalDocument(savedTable) === canonicalDocument(originalTable),
    'Table content or identity changed',
  );
  const paragraph = saved.blocks[0];
  assert(paragraph?.type === 'paragraph', 'First paragraph missing');
  if (paragraph?.type === 'paragraph')
    assert(
      paragraph.runs[0]?.style.bold === true && paragraph.runs[0]?.style.color === '#123456',
      'Formatting changed',
    );
  if (paragraph?.type === 'paragraph')
    assert(
      paragraph.runs[0]?.style.hyperlink === 'https://example.com/owned-link',
      'Hyperlink changed',
    );
  assert(
    canonicalDocument(saved.layout.header) === canonicalDocument(document.layout.header),
    'Header changed',
  );
  const again: ProserDocument = structuredClone(saved);
  editor.destroy();
  editor = new CanvasEditor(host, documentToCanvas(again), {
    defaultFont: 'Georgia',
    defaultSize: 16,
  });
  const reopened = canvasToDocument(
    editor.command.getValue({ extraPickAttrs: ['id'] }).data,
    again,
    id,
  );
  assert(
    projectDocument(reopened).text === projectDocument(document).text,
    'Reopening changed text',
  );
  assert(
    reopened.blocks
      .filter((block) => block.type === 'paragraph')
      .map((block) => block.id)
      .join() ===
      again.blocks
        .filter((block) => block.type === 'paragraph')
        .map((block) => block.id)
        .join(),
    'Paragraph identities changed on reopen',
  );
  editor.destroy();
  const typing = documentFromText('ABCDE\n\nUntouched paragraph', id);
  const typingParagraph = typing.blocks[0];
  if (typingParagraph.type !== 'paragraph') throw new Error('Invalid typing fixture');
  typingParagraph.runs[0]!.style = { bold: true };
  editor = new CanvasEditor(host, documentToCanvas(typing));
  editor.command.executeSetRange(2, 2);
  editor.command.executeInsertElementList([{ value: 'Z', bold: true }]);
  const typed = canvasToDocument(
    editor.command.getValue({ extraPickAttrs: ['id'] }).data,
    typing,
    id,
  );
  assert(
    projectDocument(typed).text === 'ABZCDE\n\nUntouched paragraph',
    'Typing changed the wrong target',
  );
  assert(
    typed.blocks[0]?.id === typing.blocks[0]?.id && typed.blocks[1]?.id === typing.blocks[1]?.id,
    'Typing changed paragraph identities',
  );
  assert(
    canonicalDocument(
      canvasToDocument(editor.command.getValue({ extraPickAttrs: ['id'] }).data, typing, id).blocks,
    ) === canonicalDocument(typed.blocks),
    'Repeated serialization changed identities',
  );
  editor.command.executeUndo();
  const undone = canvasToDocument(
    editor.command.getValue({ extraPickAttrs: ['id'] }).data,
    typing,
    id,
  );
  assert(projectDocument(undone).text === projectDocument(typing).text, 'Undo failed');
  editor.command.executeRedo();
  const redone = canvasToDocument(
    editor.command.getValue({ extraPickAttrs: ['id'] }).data,
    typing,
    id,
  );
  assert(
    canonicalDocument(redone.blocks) === canonicalDocument(typed.blocks),
    'Redo changed content or identity',
  );
  editor.command.executeSetRange(3, 3);
  editor.command.executeInsertElementList([{ value: '\n' }]);
  const split = canvasToDocument(
    editor.command.getValue({ extraPickAttrs: ['id'] }).data,
    typing,
    id,
  );
  assert(
    projectDocument(split).text === 'ABZ\n\nCDE\n\nUntouched paragraph',
    'Paragraph split changed text',
  );
  assert(
    canonicalDocument(
      canvasToDocument(editor.command.getValue({ extraPickAttrs: ['id'] }).data, typing, id).blocks,
    ) === canonicalDocument(split.blocks),
    'Split paragraph identities changed on serialization',
  );
  editor.command.executeUndo();
  editor.command.executeRedo();
  assert(
    canonicalDocument(
      canvasToDocument(editor.command.getValue({ extraPickAttrs: ['id'] }).data, typing, id).blocks,
    ) === canonicalDocument(split.blocks),
    'Split identities changed through history',
  );
  editor.destroy();
  editor = undefined;
  const anchors = documentFromText(
    'Repeated 😀 e\u0301 text\nsoft\n\nRepeated 😀 e\u0301 text',
    id,
  );
  editor = new CanvasEditor(host, documentToCanvas(anchors));
  const repeated = editor.command.getKeywordRangeList('Repeated');
  assert(repeated.length === 2, 'Repeated quotation fixture is invalid');
  editor.command.executeSetRange(repeated[1]!.startIndex, repeated[1]!.endIndex);
  const anchored = canvasSelection(editor.command, anchors);
  assert(
    anchored?.targets[0]?.blockId === anchors.blocks[1]?.id &&
      anchored.targets[0].sourceText === 'Repeated' &&
      anchored.targets[0].from === 0,
    `Selection relocated to a repeated quotation: ${JSON.stringify(anchored)}`,
  );
  const unicode = editor.command.getKeywordRangeList('😀 e\u0301');
  editor.command.executeSetRange(unicode[1]!.startIndex, unicode[1]!.endIndex);
  const unicodeAnchor = canvasSelection(editor.command, anchors);
  assert(
    unicodeAnchor?.targets[0]?.from === 9 &&
      unicodeAnchor.targets[0].to === 14 &&
      unicodeAnchor.targets[0].sourceText === '😀 e\u0301',
    'Unicode UTF-16 offsets changed',
  );
  assert(
    editor.command.getKeywordRangeList('e').length === 8,
    'Search selected half a combining grapheme',
  );
  const endPhrase = editor.command.getKeywordRangeList('text')[1]!;
  editor.command.executeSetRange(repeated[0]!.startIndex, endPhrase.endIndex);
  const acrossParagraphs = canvasSelection(editor.command, anchors);
  assert(
    acrossParagraphs?.targets.length === 2 &&
      acrossParagraphs.targets[1]?.blockId === anchors.blocks[1]?.id &&
      acrossParagraphs.targets[1]?.from === 0,
    'Cross-paragraph selection lost stable boundaries',
  );
  const soft = editor.command.getKeywordRangeList('soft')[0]!;
  editor.command.executeSetRange(soft.startIndex, soft.endIndex);
  const softAnchor = canvasSelection(editor.command, anchors);
  assert(
    softAnchor?.targets[0]?.from === 20 && softAnchor.targets[0].sourceText === 'soft',
    'Soft line break changed paragraph offsets',
  );
  const staleAnchors = structuredClone(anchors);
  const staleParagraph = staleAnchors.blocks[0];
  if (staleParagraph?.type === 'paragraph') staleParagraph.runs[0]!.text = 'Changed text';
  let staleRejected = false;
  try {
    canvasSelection(editor.command, staleAnchors);
  } catch {
    staleRejected = true;
  }
  assert(staleRejected, 'Stale selection was silently attached');
  editor.destroy();
  editor = undefined;
  const cellAnchors = documentFromText('Before table', id);
  const anchorTable = structuredClone(originalTable);
  anchorTable.rows[0]!.cells[0]!.paragraphs[0]!.runs[0]!.text = '😀 Repeated e\u0301';
  anchorTable.rows[0]!.cells[1]!.paragraphs[0]!.runs[0]!.text = '😀 Repeated e\u0301';
  cellAnchors.blocks.push(anchorTable, ...documentFromText('İ final tail', id).blocks);
  editor = new CanvasEditor(host, documentToCanvas(cellAnchors));
  const cells = editor.command.getKeywordRangeList('Repeated');
  assert(cells.length === 2, 'Table search failed');
  const cellRange = cells[1]!;
  editor.command.executeSetPositionContext(cellRange);
  editor.command.executeSetRange(cellRange.startIndex, cellRange.endIndex);
  const cellSelection = canvasSelection(editor.command, cellAnchors);
  const canonicalCell = anchorTable.rows[0]!.cells[1]!;
  assert(
    cellSelection?.container.cellId === canonicalCell.id &&
      cellSelection.container.rowId === anchorTable.rows[0]!.id &&
      cellSelection.container.tableId === anchorTable.id &&
      cellSelection.targets[0]?.blockId === canonicalCell.paragraphs[0]?.id &&
      cellSelection.targets[0]?.from === 3 &&
      cellSelection.targets[0]?.sourceText === 'Repeated',
    'Table cell identity or UTF-16 offsets changed',
  );
  const tail = editor.command.getKeywordRangeList('final tail')[0]!;
  editor.command.executeSetPositionContext(tail);
  editor.command.executeSetRange(tail.startIndex, tail.endIndex);
  assert(
    canvasSelection(editor.command, cellAnchors)?.targets[0]?.sourceText === 'final tail',
    'Search after a table or case-fold expansion shifted the target',
  );
  assert(
    editor.command.getKeywordRangeList('i').length === 2,
    'Partial case-fold expansion was selected',
  );
  editor.command.executeSetRange(0, tail.endIndex);
  let protectedRejected = false;
  try {
    canvasSelection(editor.command, cellAnchors);
  } catch {
    protectedRejected = true;
  }
  assert(protectedRejected, 'A selection across a table was accepted as plain text');
  editor.destroy();
  editor = undefined;
  const semanticHost = window.document.createElement('div');
  window.document.body.append(semanticHost);
  const root = createRoot(semanticHost);
  let semanticSelected: DocumentSelection | undefined;
  let semanticFailure: string | undefined;
  try {
    flushSync(() =>
      root.render(
        createElement(SemanticDocument, {
          document: cellAnchors,
          editable: true,
          onSelection: (selection, error) => {
            semanticSelected = selection;
            semanticFailure = error;
          },
        }),
      ),
    );
    const input = semanticHost.querySelector(
      `[data-cell-id="${canonicalCell.id}"] textarea`,
    ) as HTMLTextAreaElement;
    assert(!!input, 'Semantic cell input missing');
    input.focus();
    input.setSelectionRange(3, 11);
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Shift' }));
    assert(
      !semanticFailure &&
        semanticSelected?.container.cellId === canonicalCell.id &&
        semanticSelected.targets[0]?.sourceText === 'Repeated',
      'Semantic input selection lost its canonical table target',
    );
  } finally {
    flushSync(() => root.unmount());
    semanticHost.remove();
  }
  const original = documentFromText('Before first.\n\nBefore second.', id);
  const reviewed = regenerateDocumentText(original, 'After first.\n\nAfter second.', id, {
    authorId: 1,
    authorName: 'Fixture author',
    createdAt: '2026-10-05T12:00:00.000Z',
    status: 'pending',
    origin: 'ai',
  });
  editor = new CanvasEditor(host, documentToCanvas(reviewed), { height: 600, width: 700 });
  const recovered = canvasToDocument(
    editor.command.getValue({ extraPickAttrs: ['id'] }).data,
    reviewed,
    id,
  );
  assert(
    canonicalDocument(recovered.blocks) === canonicalDocument(reviewed.blocks),
    'Paragraph review identities were lost',
  );
  assert(
    projectDocument(recovered, 'original').text === 'Before first.\n\nBefore second.',
    'Original paragraph view was lost',
  );
  editor.destroy();
  editor = undefined;
  const mobile = documentFromText('Readable phone typography.\n\nNext paragraph.', id);
  mobile.blocks.splice(1, 0, { type: 'pageBreak', id: id() });
  editor = new CanvasEditor(host, documentToCanvas(mobile), {
    pageMode: PageMode.CONTINUITY,
    width: 340,
    height: mobile.layout.height,
    margins: [24, 16, 24, 16],
    defaultFont: mobile.layout.font,
    defaultSize: mobile.layout.fontSize,
  });
  editor.command.executePaperSize(380, mobile.layout.height);
  editor.command.executeSetRange(2, 2);
  editor.command.executeInsertElementList([{ value: 'Z' }]);
  const mobileDraft = canvasToDocument(
    editor.command.getValue({ extraPickAttrs: ['id'] }).data,
    mobile,
    id,
  );
  assert(
    canonicalDocument(mobileDraft.layout) === canonicalDocument(mobile.layout),
    'Responsive viewport changed saved page geometry',
  );
  assert(
    mobileDraft.blocks.find((block) => block.type === 'pageBreak')?.id === mobile.blocks[1]?.id,
    'Page break identity changed through serialization',
  );
  editor.command.executeUndo();
  assert(
    projectDocument(
      canvasToDocument(editor.command.getValue({ extraPickAttrs: ['id'] }).data, mobile, id),
    ).text === projectDocument(mobile).text,
    'Viewport resizing interfered with typing undo',
  );
  editor.destroy();
  editor = undefined;
  const styled = documentFromText('Heading 😀\n\nFirst item\n\nSecond item', id);
  const styledHeading = styled.blocks[0];
  const firstItem = styled.blocks[1];
  const secondItem = styled.blocks[2];
  if (
    styledHeading?.type !== 'paragraph' ||
    firstItem?.type !== 'paragraph' ||
    secondItem?.type !== 'paragraph'
  )
    throw new Error('Invalid paragraph fixture');
  styledHeading.style = { heading: 2, name: 'Heading 2' };
  firstItem.style.list = 'number';
  secondItem.style.list = 'number';
  editor = new CanvasEditor(host, documentToCanvas(styled), {
    defaultFont: styled.layout.font,
    defaultSize: styled.layout.fontSize,
    title: canvasTitleOptions(styled.layout.fontSize),
  });
  assert(
    canonicalDocument(
      canvasToDocument(editor.command.getValue({ extraPickAttrs: ['id'] }).data, styled, id).blocks,
    ) === canonicalDocument(styled.blocks),
    'Native Canvas changed implicit heading defaults or list identity on reopen',
  );
  editor.command.executeSetRange(2, 2);
  assert(
    editor.command.getRangeContext()?.startElement.level === TitleLevel.SECOND,
    'Canvas heading level was not rendered into the runtime range',
  );
  editor.command.executeTitle(TitleLevel.FIRST);
  const retitled = canvasToDocument(
    editor.command.getValue({ extraPickAttrs: ['id'] }).data,
    styled,
    id,
  );
  const nativeHeading = retitled.blocks[0];
  assert(
    nativeHeading?.type === 'paragraph' &&
      nativeHeading.id === styledHeading.id &&
      nativeHeading.style.heading === 1,
    'Native heading command lost its canonical paragraph target',
  );
  const firstItemIndex =
    [
      ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
        styledHeading.runs.map((run) => run.text).join(''),
      ),
    ].length + 3;
  editor.command.executeSetRange(firstItemIndex, firstItemIndex);
  assert(
    editor.command.getRangeContext()?.startElement.listType === ListType.OL,
    'Canvas list semantics were not rendered',
  );
  editor.command.executeList(null);
  const unlisted = canvasToDocument(
    editor.command.getValue({ extraPickAttrs: ['id'] }).data,
    retitled,
    id,
  );
  const changedItem = unlisted.blocks[1];
  const unchangedItem = unlisted.blocks[2];
  assert(
    changedItem?.type === 'paragraph' && changedItem.id === firstItem.id && !changedItem.style.list,
    'Native list removal resurrected stale metadata',
  );
  assert(
    unchangedItem?.type === 'paragraph' &&
      unchangedItem.id === secondItem.id &&
      unchangedItem.style.list === 'number',
    'Native list removal changed another paragraph',
  );
  editor.destroy();
  editor = undefined;
  const externalHistory = documentFromText('External history source', id);
  editor = new CanvasEditor(host, documentToCanvas(externalHistory), { historyMaxRecordCount: 0 });
  let documentEvents = 0;
  editor.listener.contentChange = () => {
    documentEvents++;
  };
  editor.command.executeSetRange(2, 2);
  editor.command.executeInsertElementList([{ value: 'X' }]);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const externalDraft = canvasToDocument(
    editor.command.getValue({ extraPickAttrs: ['id'] }).data,
    externalHistory,
    id,
  );
  assert(
    documentEvents > 0 &&
      projectDocument(externalDraft).text !== projectDocument(externalHistory).text,
    `Disabling native history suppressed document changes: events=${documentEvents} before=${projectDocument(externalHistory).text} after=${projectDocument(externalDraft).text}`,
  );
  editor.command.executeUndo();
  assert(
    projectDocument(
      canvasToDocument(editor.command.getValue({ extraPickAttrs: ['id'] }).data, externalDraft, id),
    ).text === projectDocument(externalDraft).text,
    'Native undo competed with external history',
  );
  editor.command.executeSetValue(documentToCanvas(externalHistory));
  assert(
    canonicalDocument(
      canvasToDocument(
        editor.command.getValue({ extraPickAttrs: ['id'] }).data,
        externalHistory,
        id,
      ).blocks,
    ) === canonicalDocument(externalHistory.blocks),
    'External history restoration lost canonical identities',
  );
  editor.destroy();
  editor = undefined;
  const journalUser = `fixture-author-${crypto.randomUUID()}`;
  const journalIntent: QuickDraftIntent = {
    userId: journalUser,
    creationId: crypto.randomUUID(),
    request: { bookId: '1', summary: 'Fixture draft', outline: 'Exact Unicode premise 😀 e\u0301' },
    bookId: '1',
    creationSent: false,
    draftSent: true,
    retryAllowed: false,
    draft: {
      schemaVersion: 1,
      operationId: crypto.randomUUID(),
      expectedRevisionId: crypto.randomUUID(),
      expectedScopes: { structure: crypto.randomUUID() },
      summary: 'Fixture draft',
      outline: 'Exact Unicode premise 😀 e\u0301',
    },
  };
  try {
    await writeQuickDraftIntent(journalIntent);
    assert(
      canonicalDocument(await readQuickDraftIntent(journalUser)) ===
        canonicalDocument(journalIntent),
      'Native journal lost the exact interrupted intent',
    );
    assert(
      !(await readQuickDraftIntent(`${journalUser}-other`)),
      'Another author could read a retained intent',
    );
    let competingRejected = false;
    try {
      await writeQuickDraftIntent({ ...journalIntent, creationId: crypto.randomUUID() });
    } catch {
      competingRejected = true;
    }
    assert(competingRejected, 'Another tab overwrote an unacknowledged intent');
    await deleteQuickDraftIntent(journalUser, crypto.randomUUID());
    assert(
      !!(await readQuickDraftIntent(journalUser)),
      'A stale acknowledgement deleted a newer intent',
    );
    await deleteQuickDraftIntent(journalUser, journalIntent.creationId);
    assert(!(await readQuickDraftIntent(journalUser)), 'Acknowledged intent was retained');
    await writeQuickDraftIntent(journalIntent);
    const journalDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('proser-document-intents', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = journalDatabase.transaction('intents', 'readwrite');
        tx.objectStore('intents').put({
          key: JSON.stringify(['quick-draft-v1', journalUser]),
          schemaVersion: 1,
          userId: journalUser,
          updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
          intent: journalIntent,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      journalDatabase.close();
    }
    assert(!(await readQuickDraftIntent(journalUser)), 'Expired intent exceeded 30-day retention');
  } finally {
    await deleteQuickDraftIntent(journalUser, journalIntent.creationId);
  }
  const reviewIntent: DocumentCompareIntent = {
    schemaVersion: 1,
    userId: journalUser,
    bookId: '1',
    sceneId: '2',
    updatedAt: Date.now(),
    request: {
      operationId: crypto.randomUUID(),
      expectedRevisionId: crypto.randomUUID(),
      expectedSceneRevisionId: crypto.randomUUID(),
      traceId: 'fixture',
      compareCardId: 1,
      chosen: 'b',
      applyChosen: true,
      validationId: crypto.randomUUID(),
    },
  };
  try {
    await writeDocumentCompareIntent(reviewIntent);
    const restored = await readDocumentCompareIntent(journalUser, '1', '2');
    assert(
      canonicalDocument(restored?.request) === canonicalDocument(reviewIntent.request),
      'Review journal lost the exact guarded request',
    );
    assert(
      !(await readDocumentCompareIntent(`${journalUser}-other`, '1', '2')),
      'Cross-user review intent exposed',
    );
    assert(
      !(await readDocumentCompareIntent(journalUser, '1', '3')),
      'Cross-scene review intent exposed',
    );
    let blocked = false;
    try {
      await writeDocumentCompareIntent({
        ...reviewIntent,
        request: { ...reviewIntent.request, operationId: crypto.randomUUID() },
      });
    } catch {
      blocked = true;
    }
    assert(blocked, 'Competing review operation replaced an unknown request');
    await deleteDocumentCompareIntent(journalUser, '1', '2', crypto.randomUUID());
    assert(
      !!(await readDocumentCompareIntent(journalUser, '1', '2')),
      'Stale review acknowledgement deleted the retained operation',
    );
    await deleteDocumentCompareIntent(journalUser, '1', '2', reviewIntent.request.operationId);
    assert(
      !(await readDocumentCompareIntent(journalUser, '1', '2')),
      'Acknowledged review intent was retained',
    );
    await writeDocumentCompareIntent({
      ...reviewIntent,
      updatedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
    });
    assert(
      !(await readDocumentCompareIntent(journalUser, '1', '2')),
      'Review retention exceeded thirty days',
    );
  } finally {
    await deleteDocumentCompareIntent(journalUser, '1', '2', reviewIntent.request.operationId);
  }
  const passageParagraph = documentFromText('A😀éZ', id)
    .blocks[0] as import('../src/document-model').DocumentParagraph;
  const passageWindow: import('@hivemagnus/proser-contracts').DocumentPassage = {
    schemaVersion: 1,
    bookRevisionId: 'book-before',
    sceneId: 2,
    sceneRevisionId: 'scene-before',
    contentHash: 'c'.repeat(64),
    projection: 'final',
    cursor: { paragraph: 17, offset: 50000 },
    paragraphs: [
      {
        paragraph: passageParagraph,
        ordinal: 17,
        offset: 50000,
        length: 1200000,
        continuedBefore: true,
        continuedAfter: true,
        runs: [
          {
            runId: passageParagraph.runs[0]!.id,
            sourceHash: 'a'.repeat(64),
            from: 50000,
            to: 50006,
            sourceLength: 1200000,
          },
        ],
      },
    ],
    images: [],
    changes: [],
    omitted: { paragraphs: 9, comments: 1, changes: 0, objects: 1 },
    layout: document.layout,
    windowHash: 'b'.repeat(64),
  };
  const passageDrafts = [
    { blockId: passageParagraph.id, runId: passageParagraph.runs[0]!.id, text: 'A😀éXYZ' },
  ];
  const passageIntent: DocumentPassageDraft = {
    schemaVersion: 1,
    userId: journalUser,
    bookId: '1',
    sceneId: '2',
    version: crypto.randomUUID(),
    updatedAt: Date.now(),
    passage: passageWindow,
    drafts: passageDrafts,
    pending: {
      kind: 'commit',
      request: passageCommit(passageWindow, passageDrafts, crypto.randomUUID(), true),
    },
  };
  try {
    await writeDocumentPassageDraft(passageIntent);
    assert(
      canonicalDocument((await readDocumentPassageDraft(journalUser, '1', '2'))?.pending) ===
        canonicalDocument(passageIntent.pending),
      'Passage journal changed immutable request',
    );
    assert(
      !(await readDocumentPassageDraft(journalUser + '-other', '1', '2')),
      'Passage journal revealed another user draft',
    );
    assert(
      !(await readDocumentPassageDraft(journalUser, '1', '3')),
      'Passage journal revealed another scene draft',
    );
    let competingBlocked = false;
    try {
      await writeDocumentPassageDraft({ ...passageIntent, version: crypto.randomUUID() });
    } catch {
      competingBlocked = true;
    }
    assert(competingBlocked, 'Competing tab replaced retained passage');
    const newest = {
      ...passageIntent,
      version: crypto.randomUUID(),
      drafts: [{ ...passageDrafts[0]!, text: 'A😀éXYZ continued during save' }],
    };
    await writeDocumentPassageDraft(newest, passageIntent.version);
    let staleDeleteBlocked = false;
    try {
      await deleteDocumentPassageDraft(journalUser, '1', '2', passageIntent.version);
    } catch {
      staleDeleteBlocked = true;
    }
    assert(
      staleDeleteBlocked &&
        (await readDocumentPassageDraft(journalUser, '1', '2'))?.version === newest.version,
      'Stale passage acknowledgement did not reject deletion and preserve newer unsent typing',
    );
    let changedRequestBlocked = false;
    try {
      await writeDocumentPassageDraft(
        {
          ...newest,
          version: crypto.randomUUID(),
          pending: {
            kind: 'commit',
            request: {
              ...(
                newest.pending as {
                  kind: 'commit';
                  request: import('@hivemagnus/proser-contracts').DocumentPassageCommit;
                }
              ).request,
              operationId: crypto.randomUUID(),
            },
          },
        },
        newest.version,
      );
    } catch {
      changedRequestBlocked = true;
    }
    assert(changedRequestBlocked, 'Passage recovery replayed unknown provider operation');
    await deleteDocumentPassageDraft(journalUser, '1', '2', newest.version);
    const expired = Date.now() - 31 * 24 * 60 * 60 * 1000;
    await writeDocumentPassageDraft({ ...passageIntent, updatedAt: expired });
    const unconfirmed = await readDocumentPassageDraft(journalUser, '1', '2');
    assert(
      Boolean(unconfirmed && (unconfirmed.pending || unconfirmed.prepared)),
      'Passage retention dropped an operation Factory never confirmed',
    );
    await deleteDocumentPassageDraft(journalUser, '1', '2', unconfirmed!.version);
    await writeDocumentPassageDraft({
      ...passageIntent,
      version: crypto.randomUUID(),
      pending: undefined,
      prepared: undefined,
      updatedAt: expired,
    });
    assert(
      !(await readDocumentPassageDraft(journalUser, '1', '2')),
      'Passage retention exceeded thirty days',
    );
  } finally {
    const retained = await readDocumentPassageDraft(journalUser, '1', '2');
    if (retained) await deleteDocumentPassageDraft(journalUser, '1', '2', retained.version);
  }
  return {
    checks: [
      'bounded passage journal exact requests, competing-tab CAS, in-flight typing protection, ownership and thirty-day retention',
      'native named paragraph/character inheritance preserves references and explicit overrides',
      'paragraph indents, spacing, pagination, logical review groups and body/table/header/footer geometry preserve canonical content and undo',
      'Unicode and whitespace',
      'raw hyperlink popup/navigation rejects active schemes and preserves visual-only defaults',
      'visual image fitting preserves canonical dimensions and protected identity',
      'literal U+200B serialization, search, selection, insertion and undo',
      'paragraph identities',
      'formatting',
      'compact external-run serialization preserves identity',
      'native heading defaults, style commands, list identity and clear semantics',
      'zero native history retains content events and external restoration identity',
      'table identities',
      'reviewed paragraph replacement',
      'serialization and reopening',
      'targeted insertion and undo/redo identity',
      'responsive viewport preserves layout and history',
      'structural break identity',
      'stable repeated-quotation and Unicode selection offsets',
      'soft line break selection and stale rejection',
      'multi-paragraph and repeated table-cell selection identities',
      'search graphemes, case-fold expansion and text after tables',
      'semantic input selection preserves canonical table ownership',
      'protected object selection rejection',
      'native interrupted-operation journal ownership and 30-day retention',
      'journal claims reject competing tabs and stale acknowledgements',
      'native compare-choice journal preserves exact requests, ownership, claims and retention',
    ],
    passed: true,
  };
}
let controlledRoot: ReturnType<typeof createRoot> | undefined;
let controlledValue: ProserDocument | undefined;
let controlledOriginal = '';
let controlledMobile = false;
let controlledEmpty = false;
let controlledNamed = false;
let controlledReadOnlyStories = false;
const controlledStoryErrors: string[] = [];
const controlledStyleDefinitions = {
  paragraph: { chapter_style: { name: 'chapter_style', heading: 2 as const } },
  text: { character_child: { bold: true, font: 'Liberation Serif', size: 22 } },
  labels: { chapter_style: '日本語 Chapter', character_child: 'Emphasis' },
};
function controlledNamedDocument() {
  const document = documentFromText('Inherited named style', id);
  const paragraph = document.blocks[0]!;
  if (paragraph.type === 'paragraph') {
    paragraph.style = { name: 'chapter_style' };
    paragraph.runs[0]!.style = { characterStyleId: 'character_child' };
  }
  return document;
}
let controlledOversized: 'paragraph' | 'table' | undefined;
let controlledSelection: DocumentSelection | undefined;
function ControlledEditor() {
  const [value, setValue] = useState(() =>
    controlledNamed
      ? controlledNamedDocument()
      : controlledOversized
        ? oversizedDocument(controlledOversized)
        : controlledEmpty
          ? { ...documentFromText('', id), blocks: [] }
          : documentFromText(
              Array.from({ length: 20 }, (_, paragraph) =>
                Array.from({ length: 100 }, (_, word) => `w0_${paragraph}_${word}`).join(' '),
              ).join('\n\n'),
              id,
            ),
  );
  if (controlledReadOnlyStories && !value.layout.header.length) {
    value.layout.header = documentFromText('Owned header story', id)
      .blocks as import('../src/document-model').DocumentParagraph[];
    value.layout.footer = documentFromText('Owned footer story', id)
      .blocks as import('../src/document-model').DocumentParagraph[];
  }
  controlledValue = value;
  return createElement(CanvasDocumentEditor, {
    document: value,
    mobile: controlledMobile,
    actorId: 7,
    namedStyles: controlledNamed ? controlledStyleDefinitions : undefined,
    onDocumentSelection: (selection) => {
      controlledSelection = selection;
    },
    onChange: setValue,
    onError: (message: string) => {
      if (controlledReadOnlyStories) controlledStoryErrors.push(message);
      else throw new Error(message);
    },
  });
}
function mountControlled(mobile = false, empty = false) {
  controlledReadOnlyStories = false;
  controlledMobile = mobile;
  controlledEmpty = empty;
  controlledOversized = undefined;
  controlledNamed = false;
  controlledSelection = undefined;
  controlledRoot?.unmount();
  host.innerHTML = '';
  controlledRoot = createRoot(host);
  flushSync(() => controlledRoot!.render(createElement(ControlledEditor)));
  controlledOriginal = projectDocument(controlledValue!).text;
}
function mountReadOnlyStories() {
  mountControlled();
  controlledRoot?.unmount();
  host.innerHTML = '';
  controlledReadOnlyStories = true;
  controlledStoryErrors.length = 0;
  controlledRoot = createRoot(host);
  flushSync(() => controlledRoot!.render(createElement(ControlledEditor)));
  controlledOriginal = projectDocument(controlledValue!).text;
}
function oversizedDocument(kind: 'paragraph' | 'table') {
  const source = documentFromText('😀 e\u0301 repeated '.repeat(800), id);
  const paragraph = source.blocks[0]!;
  if (kind === 'table' && paragraph.type === 'paragraph')
    source.blocks = [
      {
        type: 'table',
        id: id(),
        widths: [130, 170],
        rows: [
          {
            id: id(),
            cells: [
              { id: id(), paragraphs: [paragraph] },
              {
                id: id(),
                paragraphs: [
                  documentFromText('Protected neighbour', id).blocks[0] as typeof paragraph,
                ],
              },
            ],
          },
        ],
      },
    ];
  return source;
}
function mountOversized(kind: 'paragraph' | 'table') {
  controlledReadOnlyStories = false;
  controlledRoot?.unmount();
  host.innerHTML = '';
  controlledOversized = kind;
  controlledNamed = false;
  controlledEmpty = false;
  controlledMobile = false;
  controlledRoot = createRoot(host);
  flushSync(() => controlledRoot!.render(createElement(ControlledEditor)));
  controlledOriginal = projectDocument(controlledValue!).text;
}
function mountNamed() {
  controlledReadOnlyStories = false;
  controlledRoot?.unmount();
  host.innerHTML = '';
  controlledOversized = undefined;
  controlledNamed = true;
  controlledEmpty = false;
  controlledMobile = false;
  controlledRoot = createRoot(host);
  flushSync(() => controlledRoot!.render(createElement(ControlledEditor)));
  controlledOriginal = projectDocument(controlledValue!).text;
}
async function imageSourceProof() {
  controlledRoot?.unmount();
  controlledRoot = undefined;
  editor?.destroy();
  host.innerHTML = '';
  const imageSource = documentFromText('Owned image', id);
  imageSource.blocks.push({
    type: 'image',
    id: id(),
    assetId: 42,
    sha256: 'a'.repeat(64),
    width: 24,
    height: 24,
    alt: 'Verified asset',
  });
  editor = new CanvasEditor(host, documentToCanvas(imageSource), {
    width: 500,
    height: 500,
    imageSourceAllowed: ownedCanvasImageSource,
    header: { disabled: true },
    footer: { disabled: true },
  });
  await editor.command.getValueAsync({ extraPickAttrs: ['id'] });
  const resizerHost = window.document.createElement('div');
  const resizerCanvas = window.document.createElement('canvas');
  host.append(resizerHost, resizerCanvas);
  const previewer = new Previewer({
    getContainer: () => resizerHost,
    getPage: () => resizerCanvas,
    getOptions: () => mergeOption({ imageSourceAllowed: ownedCanvasImageSource }),
    getEventBus: () => ({ emit: () => {} }),
    getMode: () => 'edit',
    isReadonly: () => false,
    isDesignMode: () => false,
    getPageNo: () => 0,
    getPageOffset: () => ({ x: 0, y: 0 }),
  } as unknown as Draw);
  const ownedElement = documentToCanvas(imageSource).main.find(
    (element) => element.type === 'image',
  )!;
  previewer.drawResizer(ownedElement);
  assert(
    resizerHost.querySelector<HTMLElement>('[class$="resizer-selection"]')?.style.display ===
      'block',
    'Owned resizer did not render',
  );
  previewer.updateResizer({
    type: 'image',
    value: 'https://image-probe.invalid/direct-resizer.png',
    width: 24,
    height: 24,
  });
  assert(
    resizerHost.querySelector<HTMLElement>('[class$="resizer-selection"]')?.style.display ===
      'none',
    'Rejected image left a stale resizer',
  );
  previewer.drawResizer(ownedElement);
  (previewer as unknown as { curElementSrc: string }).curElementSrc =
    'https://image-probe.invalid/drag.png';
  resizerHost
    .querySelector<HTMLElement>('[class$="resizer-selection"] div')!
    .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  assert(
    resizerHost.querySelector<HTMLElement>('[class$="resizer-selection"]')?.style.display ===
      'none',
    'Drag did not revalidate its actual image source',
  );
  resizerHost.remove();
  resizerCanvas.remove();
  const raw = {
    type: 'image',
    value: 'https://image-probe.invalid/batch.png',
    width: 24,
    height: 24,
  };
  editor.command.executeSetRange(1, 1);
  editor.command.executeInsertElementList([raw]);
  editor.command.executeUndo();
  editor.command.executeRedo();
  editor.command.executeSetHTML({
    main: '<p>Paste</p><img src="https://image-probe.invalid/paste.png" srcset="https://image-probe.invalid/srcset.png 2x" width="24" height="24"><table><tr><td><img src="https://image-probe.invalid/cell.png" width="24" height="24"></td></tr></table><div style="background:url(https://image-probe.invalid/background.png)">Text</div>',
  });
  await editor.command.getValueAsync({ extraPickAttrs: ['id'] });
  assert(
    editor.command
      .getValue({ extraPickAttrs: ['id'] })
      .data.main.some((element) => element.value === 'https://image-probe.invalid/paste.png'),
    'Rejected source was silently discarded',
  );
  editor.command.executeSetValue(documentToCanvas(imageSource));
  await editor.command.getValueAsync({ extraPickAttrs: ['id'] });
  assert(
    canonicalDocument(
      canvasToDocument(editor.command.getValue({ extraPickAttrs: ['id'] }).data, imageSource, id),
    ) === canonicalDocument(imageSource),
    'Owned image source changed canonical document',
  );
  editor.destroy();
  return { owned: true, rejectedRetained: true };
}
function mountLayoutExample() {
  controlledReadOnlyStories = false;
  controlledRoot?.unmount();
  controlledRoot = undefined;
  editor?.destroy();
  host.innerHTML = '';
  const example = documentFromText(
    'A measured writing page\n\n' +
      'The page keeps its typography, paragraph identities and generous reading rhythm. '.repeat(
        5,
      ) +
      '\n\nA deliberate new page\n\n' +
      'Tables retain their original dimensions while the working view fits the page. '.repeat(3),
    id,
  );
  example.layout = {
    ...example.layout,
    width: 600,
    height: 800,
    margins: [60, 50, 60, 50],
    font: 'Liberation Serif',
    fontSize: 16,
  };
  const first = example.blocks[0];
  const body = example.blocks[1];
  const next = example.blocks[2];
  if (first?.type !== 'paragraph' || body?.type !== 'paragraph' || next?.type !== 'paragraph')
    throw new Error('Example');
  first.style = { name: 'Heading1', heading: 1, after: 20, keepWithNext: true };
  first.runs[0]!.style = { font: 'Liberation Serif', size: 28, bold: true };
  body.style = { indent: 20, firstLineIndent: 24, before: 8, after: 12, lineSpacing: 1.2 };
  next.style = { pageBreakBefore: true, heading: 2, after: 14 };
  const cells = ['Original column one', 'Original column two'].map((text) => ({
    id: id(),
    paragraphs: documentFromText(text, id)
      .blocks as import('../src/document-model').DocumentParagraph[],
  }));
  example.blocks.push({ type: 'table', id: id(), widths: [400, 400], rows: [{ id: id(), cells }] });
  example.layout.header = documentFromText('PROSER / WORKING PAGE', id)
    .blocks as import('../src/document-model').DocumentParagraph[];
  example.layout.header[0]!.runs[0]!.style = { font: 'Liberation Sans', size: 12 };
  example.layout.footer = documentFromText('A preserved document', id)
    .blocks as import('../src/document-model').DocumentParagraph[];
  example.layout.footer[0]!.runs[0]!.style = { font: 'Liberation Sans', size: 12 };
  editor = new CanvasEditor(host, documentToCanvas(example), {
    width: 600,
    height: 800,
    margins: [60, 50, 60, 50],
    defaultFont: 'Liberation Serif',
    defaultSize: 16,
    pageNumber: { disabled: false },
  });
  return {
    exact:
      canonicalDocument(
        canvasToDocument(editor.command.getValue({ extraPickAttrs: ['id'] }).data, example, id),
      ) === canonicalDocument(example),
    pages: host.querySelectorAll('canvas[data-index]').length,
  };
}
type CaretFormattingProperty = 'bold' | 'italic' | 'underline' | 'strikeout';
let caretFormattingEditor: CanvasEditor | undefined;
let caretFormattingHost: HTMLDivElement | undefined;
function unmountCaretFormatting() {
  caretFormattingEditor?.destroy();
  caretFormattingEditor = undefined;
  caretFormattingHost?.remove();
  caretFormattingHost = undefined;
}
/** Neutral native input regression: no application document or React state. */
function mountCaretFormatting(
  property: CaretFormattingProperty,
  initial: boolean,
  toggles: number,
) {
  unmountCaretFormatting();
  caretFormattingHost = window.document.createElement('div');
  window.document.body.append(caretFormattingHost);
  const instance = new CanvasEditor(
    caretFormattingHost,
    { main: [{ value: 'ABC', [property]: initial }] },
    { header: { disabled: true }, footer: { disabled: true } },
  );
  caretFormattingEditor = instance;
  instance.command.executeSetRange(1, 1);
  instance.command.executeFocus({ range: instance.command.getRange() });
  const commands = {
    bold: () => instance.command.executeBold(),
    italic: () => instance.command.executeItalic(),
    underline: () => instance.command.executeUnderline(),
    strikeout: () => instance.command.executeStrikeout(),
  };
  for (let index = 0; index < toggles; index++) commands[property]();
  instance.command.executeFocus({ range: instance.command.getRange() });
}
Object.assign(window, {
  canvasAcceptance: {
    identityAcceptance,
    run,
    mountCaretFormatting,
    caretFormattingValue: () =>
      caretFormattingEditor!.command.getValue({ extraPickAttrs: ['id'] }).data.main,
    unmountCaretFormatting,
    mountControlled,
    mountOversized,
    mountNamed,
    mountLayoutExample,
    mountReadOnlyStories,
    storyErrors: () => controlledStoryErrors,
    imageSourceProof,
    controlled: () => ({
      text: projectDocument(controlledValue!).text,
      original: controlledOriginal,
      originalView: projectDocument(controlledValue!, 'original').text,
      document: controlledValue,
      selection: controlledSelection,
    }),
    unmountControlled: () => {
      controlledRoot?.unmount();
      controlledRoot = undefined;
    },
  },
});
