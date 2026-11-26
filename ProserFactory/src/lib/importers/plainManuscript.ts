import { DocumentError } from '@/documents/errors';
import { summarize, type ManuscriptAct, type ManuscriptChapter, type ManuscriptScene } from './legacyManuscript';

/** Single-file manuscripts a writer keeps outside Proser. */
export type PlainManuscriptFormat = 'markdown' | 'plain-text';
export const plainManuscriptFormats: readonly PlainManuscriptFormat[] = ['markdown', 'plain-text'];

export interface PlainManuscript {
  title: string;
  byline: string | null;
  acts: ManuscriptAct[];
  encoding: 'utf-8' | 'windows-1252';
  paragraphMode: 'blank-line' | 'line';
  sceneBreakCount: number;
  demotedHeadingCount: number;
  frontmatterRemoved: boolean;
}

// The outline append bounds (structureCommands.ts).
const MAX_ACTS = 20;
const MAX_CHAPTERS_PER_ACT = 100;
const MAX_SCENES_PER_CHAPTER = 100;
const HEADING_TEXT_LIMIT = 500;

const fence = /^\s{0,3}(```|~~~)/;
const atxHeading = /^\s{0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const markdownSceneBreak = /^\s{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|#)[ \t]*$/;
const textSceneBreak = /^\s*(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:~[ \t]*){1,3}|#|§)[ \t]*$/;
const numberWord = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred';
const ordinal = `(?:\\d+|(?=[ivxlcdm])m{0,3}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})|(?:${numberWord})(?:[\\s-]+(?:and[\\s-]+)?(?:${numberWord}))*)`;
// The number may stand alone, take a separated title ("Chapter 3: The Storm")
// or a title without sentence punctuation ("Chapter Three The Storm").
const numbered = (words: string) => new RegExp(`^(?:${words})\\s+${ordinal}(?:\\s*[:.\\u2013\\u2014-]\\s*.*|\\s+.*[^.!?,;]|)$`, 'i');
const partHeading = numbered('part|book|act|volume');
const textChapterHeading = new RegExp(`${numbered('chapter|ch\\.').source}|^(?:prologue|epilogue|interlude|afterword|foreword|preface|introduction)(?:\\s*[:.\\u2013\\u2014-]\\s*.*)?$`, 'i');

/** Read UTF-8, falling back to Windows-1252 for files saved by older word
 * processors. A byte order mark is not part of the manuscript. */
export function decodeManuscriptText(bytes: Uint8Array): { text: string; encoding: PlainManuscript['encoding'] } {
  let text: string; let encoding: PlainManuscript['encoding'] = 'utf-8';
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { text = new TextDecoder('windows-1252').decode(bytes); encoding = 'windows-1252'; }
  if (text.includes('\u0000')) throw new DocumentError('DOCUMENT_IMPORT_INVALID', 'This file is not a text manuscript. The original remains preserved.', 422);
  return { text: text.replace(/^﻿/, '').replace(/\r\n?/g, '\n'), encoding };
}

interface Heading { line: number; level: number; text: string }

function words(text: string) { return text.trim().split(/\s+/).filter(Boolean).length; }
function headingTitle(text: string) { return text.trim().slice(0, HEADING_TEXT_LIMIT); }

/** Join each paragraph's lines. Markdown hard breaks (two trailing spaces or a
 * backslash) stay line breaks; every other line break inside a paragraph is a
 * space, as Markdown renders it and as hard-wrapped text reads. */
function paragraphs(lines: string[], format: PlainManuscriptFormat, mode: PlainManuscript['paragraphMode']): string {
  const result: string[] = []; let current: string[] = [];
  const flush = () => {
    if (!current.length) return;
    let text = '';
    current.forEach((line, index) => {
      const last = index === current.length - 1;
      const hard = format === 'markdown' && /(?: {2,}|\\)$/.test(line);
      const content = (hard ? line.replace(/(?: {2,}|\\)$/, '') : line).trim();
      text += content + (last ? '' : hard ? '\n' : ' ');
    });
    if (text.trim()) result.push(text.trim());
    current = [];
  };
  for (const line of lines) {
    if (!line.trim()) { flush(); continue; }
    current.push(line);
    if (mode === 'line') flush();
  }
  flush();
  return result.join('\n\n');
}

/** Map a Markdown or plain-text manuscript to acts, chapters and scenes.
 * Chapter headings start chapters, part headings start acts, and scene-break
 * lines split chapters into scenes. Text before the first chapter becomes an
 * opening chapter, so no prose is dropped. */
export function parsePlainManuscript(bytes: Uint8Array, format: PlainManuscriptFormat, fallbackTitle: string): PlainManuscript {
  const decoded = decodeManuscriptText(bytes);
  let lines = decoded.text.split('\n');
  let frontmatterTitle: string | undefined; let frontmatterRemoved = false;
  if (format === 'markdown' && lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0 && end <= 200) {
      for (const line of lines.slice(1, end)) { const match = line.match(/^title:\s*["']?(.+?)["']?\s*$/i); if (match) frontmatterTitle = match[1]; }
      lines = lines.slice(end + 1); frontmatterRemoved = true;
    }
  }
  const sceneBreak = format === 'markdown' ? markdownSceneBreak : textSceneBreak;
  const blankLines = lines.filter((line) => !line.trim()).length;
  const textLines = lines.length - blankLines;
  // Word processors that save as text write one paragraph per line with no
  // blank lines between them.
  const paragraphMode: PlainManuscript['paragraphMode'] = format === 'plain-text' && textLines > 3 && blankLines * 20 < textLines ? 'line' : 'blank-line';

  const headings: Heading[] = [];
  if (format === 'markdown') {
    let fenced: string | null = null;
    lines.forEach((line, index) => {
      const marker = line.match(fence)?.[1];
      if (marker) { fenced = fenced === null ? marker : fenced === marker ? null : fenced; return; }
      if (fenced !== null || markdownSceneBreak.test(line)) return;
      const match = line.match(atxHeading);
      if (match) headings.push({ line: index, level: match[1].length, text: match[2] });
    });
  } else {
    lines.forEach((line, index) => {
      const text = line.trim();
      const separated = paragraphMode === 'line' || index === 0 || !lines[index - 1].trim();
      if (!separated || text.length > 120) return;
      if (partHeading.test(text)) headings.push({ line: index, level: 1, text });
      else if (textChapterHeading.test(text)) headings.push({ line: index, level: 2, text });
    });
  }

  // A lone top-level heading before every other heading is the book title.
  let title = frontmatterTitle ?? fallbackTitle; const consumed = new Set<number>();
  if (format === 'markdown' && headings.length > 1) {
    const top = Math.min(...headings.map((heading) => heading.level));
    const atTop = headings.filter((heading) => heading.level === top);
    if (atTop.length === 1 && headings[0] === atTop[0]) { title = headingTitle(atTop[0].text); consumed.add(atTop[0].line); }
  } else if (format === 'plain-text' && headings.length) {
    const first = lines.findIndex((line) => line.trim());
    const candidate = lines[first]?.trim() ?? '';
    if (first >= 0 && first < headings[0].line && candidate.length <= 120 && !/[.!?,;:"”’)]$/.test(candidate) && !lines[first + 1]?.trim()) { title = candidate; consumed.add(first); }
  }
  const structural = headings.filter((heading) => !consumed.has(heading.line));
  let partLevel: number | null = null; let chapterLevel: number | null = null;
  if (structural.length) {
    const levels = [...new Set(structural.map((heading) => heading.level))].sort((a, b) => a - b);
    const top = structural.filter((heading) => heading.level === levels[0]);
    if (levels.length > 1 && top.every((heading) => heading.text.trim().length <= 120 && partHeading.test(heading.text.trim()))) { partLevel = levels[0]; chapterLevel = levels[1]; }
    else chapterLevel = levels[0];
  }
  const byHeading = new Map(structural.map((heading) => [heading.line, heading]));
  const bylineLine = lines.findIndex((line, index) => index < (structural[0]?.line ?? lines.length) && /^by\s+\S/i.test(line.trim()) && line.trim().length <= 200);
  if (bylineLine >= 0) consumed.add(bylineLine);

  const acts: ManuscriptAct[] = [];
  let act: ManuscriptAct | null = null;
  let chapter: { title: string; lines: string[]; implicit: boolean } | null = null;
  let sceneBreakCount = 0; let demotedHeadingCount = 0;
  const closeChapter = () => {
    if (!chapter) return;
    const scenes: string[][] = [[]];
    for (const line of chapter.lines) { if (sceneBreak.test(line)) { sceneBreakCount += 1; scenes.push([]); } else scenes.at(-1)!.push(line); }
    const bodies = scenes.map((sceneLines) => paragraphs(sceneLines, format, paragraphMode)).filter(Boolean);
    if (bodies.length || !chapter.implicit) {
      if (!act) { act = { number: acts.length + 1, title: 'Imported Manuscript', chapters: [] }; acts.push(act); }
      if (act.chapters.length >= MAX_CHAPTERS_PER_ACT) { act = { number: acts.length + 1, title: `Imported Manuscript (continued ${acts.length + 1})`, chapters: [] }; acts.push(act); }
      if (bodies.length > MAX_SCENES_PER_CHAPTER) throw new DocumentError('DOCUMENT_IMPORT_TOO_LARGE', `"${chapter.title}" has more than ${MAX_SCENES_PER_CHAPTER} scenes. Split it into chapters and import again.`, 422);
      const prose = bodies.join('\n\n');
      const sceneList: ManuscriptScene[] = (bodies.length ? bodies : ['']).map((body, index) => ({ number: index + 1, prose: body, summary: summarize(body, 180), outline: `Imported manuscript content for ${chapter!.title}.`, wordCount: words(body) }));
      const item: ManuscriptChapter = { number: act.chapters.length + 1, title: chapter.title, prose, summary: summarize(prose), wordCount: words(prose), scenes: sceneList };
      act.chapters.push(item);
    }
    chapter = null;
  };
  lines.forEach((line, index) => {
    if (consumed.has(index)) return;
    const heading = byHeading.get(index);
    if (heading && heading.level === partLevel) {
      closeChapter();
      act = { number: acts.length + 1, title: headingTitle(heading.text), chapters: [] }; acts.push(act);
      return;
    }
    if (heading && heading.level === chapterLevel) { closeChapter(); chapter = { title: headingTitle(heading.text), lines: [], implicit: false }; return; }
    if (!chapter) { if (!line.trim()) return; chapter = { title: structural.length ? 'Opening' : 'Imported Chapter', lines: [], implicit: true }; }
    if (heading) { demotedHeadingCount += 1; chapter.lines.push(heading.text); return; }
    chapter.lines.push(line);
  });
  closeChapter();
  const filled = acts.filter((item) => item.chapters.length);
  if (!filled.length) throw new DocumentError('DOCUMENT_IMPORT_EMPTY', 'The manuscript contains no text. The original remains preserved.', 422);
  if (filled.length > MAX_ACTS) throw new DocumentError('DOCUMENT_IMPORT_TOO_LARGE', `The manuscript has more than ${MAX_ACTS} parts. Merge some parts and import again.`, 422);
  filled.forEach((item, index) => { item.number = index + 1; });
  return { title, byline: bylineLine >= 0 ? lines[bylineLine].trim() : null, acts: filled, encoding: decoded.encoding, paragraphMode, sceneBreakCount, demotedHeadingCount, frontmatterRemoved };
}
