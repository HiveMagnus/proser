'use client';

import { cn } from '@/lib/utils';

export interface MobileParagraph {
  id: string;
  text: string;
}

export function normalizeProseText(value?: string | null) {
  if (!value) return '';
  if (!/<[^>]+>/.test(value)) return value;
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<\/div>\s*<div>/gi, '\n\n')
    .replace(/<\/(p|div|h[1-6]|blockquote)>/gi, '\n\n')
    .replace(/<li>/gi, '- ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function splitParagraphs(text: string): MobileParagraph[] {
  return normalizeProseText(text)
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph, index) => ({ id: `paragraph-${index}`, text: paragraph }));
}

export function replaceParagraph(text: string, index: number, nextParagraph: string): string {
  const paragraphs = splitParagraphs(text).map((paragraph) => paragraph.text);
  if (index < 0 || index >= paragraphs.length) return text;
  paragraphs[index] = nextParagraph.trim();
  return paragraphs.join('\n\n');
}

export function MobileArticle({
  prose,
  selectable = false,
  selectedIndex = null,
  onSelect,
}: {
  prose: string;
  selectable?: boolean;
  selectedIndex?: number | null;
  onSelect?: (index: number) => void;
}) {
  const paragraphs = splitParagraphs(prose);

  if (paragraphs.length === 0) {
    return (
      <div className="rounded-[--radius-xl] border border-dashed border-border-strong bg-surface-sunken px-4 py-6 text-center text-[length:--text-sm] text-text-secondary">
        No prose yet. Generate a draft to see it here.
      </div>
    );
  }

  return (
    <article className="space-y-4 rounded-[--radius-xl] border border-border-muted bg-surface-raised/70 px-4 py-5">
      {paragraphs.map((paragraph, index) => {
        const active = selectable && selectedIndex === index;
        const content = (
          <p
            className={cn(
              'whitespace-pre-wrap font-[--font-manuscript] text-[1.02rem] leading-8 text-text-primary',
              active && 'rounded-[--radius-md] bg-accent-500/10 px-3 py-2',
            )}
          >
            {paragraph.text}
          </p>
        );

        if (!selectable) return <div key={paragraph.id}>{content}</div>;

        return (
          <button
            key={paragraph.id}
            type="button"
            onClick={() => onSelect?.(index)}
            className="block w-full text-left"
          >
            {content}
          </button>
        );
      })}
    </article>
  );
}
