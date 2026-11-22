export type ManuscriptScene = {
  number: number;
  prose: string;
  summary: string;
  outline: string;
  wordCount: number;
};

export type ManuscriptChapter = {
  number: number;
  title: string;
  prose: string;
  summary: string;
  wordCount: number;
  scenes: ManuscriptScene[];
};

export type ManuscriptAct = {
  number: number;
  title: string;
  chapters: ManuscriptChapter[];
};

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function summarize(text: string, maxLength = 280): string {
  const clean = stripMarkdown(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLength) {
    return clean;
  }
  return `${clean.slice(0, maxLength - 1).trimEnd()}...`;
}

function splitChapterIntoScenes(chapterTitle: string, prose: string): ManuscriptScene[] {
  const sceneBodies = prose
    .split(/\n\s*\*\s*\*\s*\*\s*\n/g)
    .map((scene) => scene.trim())
    .filter(Boolean);

  const normalizedBodies = sceneBodies.length > 0 ? sceneBodies : [prose.trim()].filter(Boolean);

  return normalizedBodies.map((sceneProse, index) => ({
    number: index + 1,
    prose: sceneProse,
    summary: summarize(sceneProse, 180),
    outline: `Imported manuscript content for ${chapterTitle}.`,
    wordCount: countWords(sceneProse),
  }));
}

export function parseManuscript(markdown: string, fallbackTitle: string): { title: string; byline: string | null; acts: ManuscriptAct[] } {
  const lines = markdown.replace(/\r/g, '').split('\n');
  const title = lines.find((line) => line.startsWith('# '))?.replace(/^#\s+/, '').trim() ?? fallbackTitle;
  const bylineLine = lines.find((line) => /^by\s+/i.test(line.trim()));
  const byline = bylineLine ? bylineLine.trim() : null;

  const acts: ManuscriptAct[] = [];
  let currentAct: ManuscriptAct | null = null;
  let currentChapter: { number: number; title: string; lines: string[] } | null = null;

  const pushChapter = () => {
    if (!currentAct || !currentChapter) return;
    const prose = currentChapter.lines.join('\n').trim();
    if (!prose) return;
    const scenes = splitChapterIntoScenes(currentChapter.title, prose);
    currentAct.chapters.push({
      number: currentChapter.number,
      title: currentChapter.title,
      prose,
      summary: summarize(prose),
      wordCount: countWords(prose),
      scenes,
    });
  };

  const pushAct = () => {
    if (!currentAct) return;
    pushChapter();
    currentChapter = null;
    acts.push(currentAct);
  };

  for (const line of lines) {
    const actMatch = line.match(/^##\s+(.+)$/);
    if (actMatch) {
      pushAct();
      currentAct = {
        number: acts.length + 1,
        title: actMatch[1].trim(),
        chapters: [],
      };
      continue;
    }

    const chapterMatch = line.match(/^###\s+Chapter\s+(\d+):\s*(.+)$/i);
    if (chapterMatch) {
      if (!currentAct) {
        currentAct = {
          number: acts.length + 1,
          title: 'Imported Manuscript',
          chapters: [],
        };
      }
      pushChapter();
      currentChapter = {
        number: Number(chapterMatch[1]),
        title: chapterMatch[2].trim(),
        lines: [],
      };
      continue;
    }

    if (line.startsWith('# ') || /^by\s+/i.test(line.trim())) {
      continue;
    }

    if (currentChapter) {
      currentChapter.lines.push(line);
    }
  }

  pushAct();

  if (acts.length === 0) {
    const prose = lines.join('\n').trim();
    return {
      title,
      byline,
      acts: [
        {
          number: 1,
          title: 'Imported Manuscript',
          chapters: [
            {
              number: 1,
              title: 'Imported Chapter',
              prose,
              summary: summarize(prose),
              wordCount: countWords(prose),
              scenes: splitChapterIntoScenes('Imported Chapter', prose),
            },
          ],
        },
      ],
    };
  }

  return { title, byline, acts };
}
