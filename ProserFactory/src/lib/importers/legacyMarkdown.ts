import MarkdownIt from 'markdown-it';
import { documentFromText, type DocumentRun, type ProserDocument, type TextStyle } from '@/documents/model';

// Convert inline syntax only. The legacy manuscript parser owns the hierarchy,
// and unsupported objects stay as text without fetching or rendering HTML.
const markdown = new MarkdownIt({ html: false }).disable(['autolink', 'entity', 'image', 'link']);
const inlineStyles = new Map<string, TextStyle>([
  ['em_open', { italic: true }],
  ['strong_open', { bold: true }],
  ['s_open', { strikeout: true }],
]);

export function formatLegacyMarkdownRun(run: DocumentRun, id: () => string): DocumentRun[] {
  const tokens = markdown.parseInline(run.text, {})[0]?.children ?? [];
  if (!tokens.some((token) => inlineStyles.has(token.type) || token.type === 'code_inline')) return [run];

  const runs: DocumentRun[] = [];
  const styles: TextStyle[] = [run.style];
  for (const token of tokens) {
    const mark = inlineStyles.get(token.type);
    if (mark) {
      styles.push({ ...styles.at(-1), ...mark });
    } else if (token.nesting === -1) {
      styles.pop();
    } else {
      const text = token.type === 'hardbreak' || token.type === 'softbreak' ? '\n' : token.content;
      if (!text) continue;
      const style = styles.at(-1)!;
      runs.push({ ...run, id: runs.length ? id() : run.id, text, style: token.type === 'code_inline' ? { ...style, font: 'monospace' } : style });
    }
  }
  return runs.length ? runs : [run];
}

export function documentFromLegacyMarkdown(text: string, id: () => string): ProserDocument {
  const document = documentFromText(text, id);
  for (const block of document.blocks) {
    if (block.type === 'paragraph') block.runs = formatLegacyMarkdownRun(block.runs[0], id);
  }
  return document;
}
