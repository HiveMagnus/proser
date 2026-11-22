import { test, expect, devices, type Page } from '@playwright/test';

test.use({ ...devices['iPhone 13'] });

type MockBook = {
  id: string;
  title: string;
  genre?: string;
  draftStatus: string;
  wordCount: number;
  summary: string | null;
  updatedAt: string;
};

type MockScene = {
  id: string;
  chapterId: string;
  sceneNumber: number;
  summary: string | null;
  outline: string | null;
  prose: string;
  wordCount: number;
};

type MockChapter = {
  id: string;
  actId: string;
  chapterNumber: number;
  title: string | null;
  summary: string | null;
  scenes: MockScene[];
};

type MockAct = {
  id: string;
  bookId: string;
  actNumber: number;
  title: string | null;
  summary: string | null;
  chapters: MockChapter[];
};

type MockStructure = {
  acts: MockAct[];
};

type RequestLog = {
  createBook: Array<Record<string, unknown>>;
  createAct: Array<Record<string, unknown>>;
  createChapter: Array<Record<string, unknown>>;
  createScene: Array<Record<string, unknown>>;
  updateScene: Array<Record<string, unknown>>;
  generate: Array<Record<string, unknown>>;
  commandRevise: Array<Record<string, unknown>>;
  preference: Array<Record<string, unknown>>;
};

type MockOptions = {
  books?: MockBook[];
  structures?: Record<string, MockStructure>;
  latestTraces?: Record<string, Record<string, unknown> | null>;
  generatedProse?: string;
  revisedScene?: string;
  revisedParagraph?: string;
  preferenceTrace?: Record<string, unknown>;
};

const FIRST_PARAGRAPH = 'Kael slipped through the ruined gate.';
const SECOND_PARAGRAPH = 'The ward lights trembled overhead.';
const GENERATED_SECOND_PARAGRAPH = 'The ward lights quivered over the avenue.';
const REVISED_PARAGRAPH = 'The ward lights snarled over the avenue, hunting for him.';
const COMPARE_OPTION_B = 'The ward lights shuddered overhead, like they remembered the last fire.';

function countWords(text: string) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function sceneKey(bookId: string, sceneId: string) {
  return `${bookId}:${sceneId}`;
}

function cloneStructure(structure: MockStructure): MockStructure {
  return JSON.parse(JSON.stringify(structure)) as MockStructure;
}

function buildBook(id: string, title: string): MockBook {
  return {
    id,
    title,
    genre: 'fantasy',
    draftStatus: 'draft',
    wordCount: 0,
    summary: null,
    updatedAt: '2026-04-10T00:00:00.000Z',
  };
}

function buildStructure({
  bookId = 'book-1',
  sceneOneProse = `${FIRST_PARAGRAPH}\n\n${SECOND_PARAGRAPH}`,
}: {
  bookId?: string;
  sceneOneProse?: string;
} = {}): MockStructure {
  return {
    acts: [
      {
        id: `${bookId}-act-1`,
        bookId,
        actNumber: 1,
        title: 'Act I',
        summary: 'The city walls begin to fail.',
        chapters: [
          {
            id: `${bookId}-chapter-1`,
            actId: `${bookId}-act-1`,
            chapterNumber: 1,
            title: 'Chapter One',
            summary: 'Kael returns under cover of dusk.',
            scenes: [
              {
                id: 'scene-1',
                chapterId: `${bookId}-chapter-1`,
                sceneNumber: 1,
                summary: 'The gate opens',
                outline: 'Kael slips back into the city just as the wards begin to shiver.',
                prose: sceneOneProse,
                wordCount: countWords(sceneOneProse),
              },
              {
                id: 'scene-2',
                chapterId: `${bookId}-chapter-1`,
                sceneNumber: 2,
                summary: 'The oath wakes',
                outline: 'Mara hears the old oath fracture inside the chapel.',
                prose: 'Mara heard the oath crack in the chapel.',
                wordCount: countWords('Mara heard the oath crack in the chapel.'),
              },
            ],
          },
          {
            id: `${bookId}-chapter-2`,
            actId: `${bookId}-act-1`,
            chapterNumber: 2,
            title: 'Chapter Two',
            summary: 'The city answers back.',
            scenes: [
              {
                id: 'scene-3',
                chapterId: `${bookId}-chapter-2`,
                sceneNumber: 1,
                summary: 'Market bells',
                outline: 'The market bells continue after the fire has passed.',
                prose: 'The market bells kept ringing long after the fire.',
                wordCount: countWords('The market bells kept ringing long after the fire.'),
              },
            ],
          },
        ],
      },
    ],
  };
}

function buildReadyTrace(): Record<string, unknown> {
  return {
    traceId: 'trace-ready-1',
    status: 'ready',
    judgeStatus: 'ready',
    recipeVersion: 'mobile-v1',
    genreKey: 'fantasy',
    adapterUsed: 'mock-judge',
    validatorResults: [],
    candidates: [],
    actions: [],
    inlineFindings: [
      {
        message: 'The ending could land with more dread.',
        suggestion: 'Make the ending sharper and more ominous.',
      },
    ],
    compareCards: [
      {
        id: 7,
        title: 'Stronger closing image',
        message: 'Option B gives the paragraph a more memorable finish.',
        excerpt: SECOND_PARAGRAPH,
        optionAText: 'The ward lights wavered overhead.',
        optionBText: COMPARE_OPTION_B,
      },
    ],
    judgeSummary: {
      headline: 'Ready for a punchier pass',
      summary: 'The scene reads cleanly, but the final image could bite harder.',
      cautions: ['Sharpen the closing image.', 'Keep Kael rooted in the scene.'],
    },
  };
}

function findStructureScene(structure: MockStructure, sceneId: string) {
  for (const act of structure.acts) {
    for (const chapter of act.chapters) {
      const scene = chapter.scenes.find((candidate) => candidate.id === sceneId);
      if (scene) {
        return { act, chapter, scene };
      }
    }
  }

  return null;
}

async function installMobileApiMocks(page: Page, options: MockOptions = {}) {
  const books = (
    options.books ?? [
      buildBook('book-1', 'Ashes of the Ward'),
      buildBook('book-2', 'Salt and Lanterns'),
    ]
  ).map((book) => ({ ...book }));

  const structures = new Map<string, MockStructure>(
    Object.entries(
      options.structures ?? {
        'book-1': buildStructure(),
        'book-2': buildStructure({
          bookId: 'book-2',
          sceneOneProse: 'Nessa waited on the flooded quay.\n\nThe gulls refused to land.',
        }),
      },
    ).map(([bookId, structure]) => [bookId, cloneStructure(structure)]),
  );

  const latestTraces = new Map<string, Record<string, unknown> | null>(
    Object.entries(
      options.latestTraces ?? {
        [sceneKey('book-1', 'scene-1')]: buildReadyTrace(),
      },
    ),
  );

  const log: RequestLog = {
    createBook: [],
    createAct: [],
    createChapter: [],
    createScene: [],
    updateScene: [],
    generate: [],
    commandRevise: [],
    preference: [],
  };

  const generatedProse =
    options.generatedProse ?? `${FIRST_PARAGRAPH}\n\n${GENERATED_SECOND_PARAGRAPH}`;
  const revisedScene =
    options.revisedScene ?? 'Kael slipped through the ruined gate as the city remembered him.';
  const revisedParagraph = options.revisedParagraph ?? REVISED_PARAGRAPH;
  const preferenceTrace = options.preferenceTrace ?? {
    ...buildReadyTrace(),
    compareCards: [],
  };

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    const body = request.postData()
      ? (JSON.parse(request.postData() as string) as Record<string, unknown>)
      : {};

    const respond = async (data: unknown, status = 200, success = true) => {
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: success,
          success,
          data,
        }),
      });
    };

    if (method === 'GET' && pathname === '/api/books') {
      await respond(books);
      return;
    }

    if (method === 'POST' && pathname === '/api/books') {
      log.createBook.push(body);
      const book: MockBook = {
        ...buildBook('book-new', String(body.title || 'Untitled Book')),
        genre: typeof body.genre === 'string' ? body.genre : 'fantasy',
        summary: typeof body.summary === 'string' ? body.summary : null,
      };
      books.push(book);
      structures.set(book.id, { acts: [] });
      await respond(book, 201);
      return;
    }

    const structureMatch = pathname.match(/^\/api\/books\/([^/]+)\/structure$/);
    if (method === 'GET' && structureMatch) {
      const bookId = decodeURIComponent(structureMatch[1]);
      await respond(structures.get(bookId) ?? { acts: [] });
      return;
    }

    const createActMatch = pathname.match(/^\/api\/books\/([^/]+)\/acts$/);
    if (method === 'POST' && createActMatch) {
      const bookId = decodeURIComponent(createActMatch[1]);
      const structure = structures.get(bookId) ?? { acts: [] };
      const act: MockAct = {
        id: `${bookId}-act-${structure.acts.length + 1}`,
        bookId,
        actNumber: structure.acts.length + 1,
        title: typeof body.title === 'string' ? body.title : `Act ${structure.acts.length + 1}`,
        summary: typeof body.summary === 'string' ? body.summary : null,
        chapters: [],
      };
      structure.acts.push(act);
      structures.set(bookId, structure);
      log.createAct.push(body);
      await respond({ act }, 201);
      return;
    }

    const createChapterMatch = pathname.match(/^\/api\/books\/([^/]+)\/acts\/([^/]+)\/chapters$/);
    if (method === 'POST' && createChapterMatch) {
      const bookId = decodeURIComponent(createChapterMatch[1]);
      const actId = decodeURIComponent(createChapterMatch[2]);
      const structure = structures.get(bookId) ?? { acts: [] };
      const act = structure.acts.find((candidate) => candidate.id === actId);

      if (!act) {
        await respond({ message: 'Act not found' }, 404, false);
        return;
      }

      const chapter: MockChapter = {
        id: `${bookId}-chapter-${act.chapters.length + 1}`,
        actId,
        chapterNumber: act.chapters.length + 1,
        title: typeof body.title === 'string' ? body.title : `Chapter ${act.chapters.length + 1}`,
        summary: typeof body.summary === 'string' ? body.summary : null,
        scenes: [],
      };
      act.chapters.push(chapter);
      log.createChapter.push(body);
      await respond({ chapter }, 201);
      return;
    }

    const createSceneMatch = pathname.match(/^\/api\/books\/([^/]+)\/chapters\/([^/]+)\/scenes$/);
    if (method === 'POST' && createSceneMatch) {
      const bookId = decodeURIComponent(createSceneMatch[1]);
      const chapterId = decodeURIComponent(createSceneMatch[2]);
      const structure = structures.get(bookId) ?? { acts: [] };

      for (const act of structure.acts) {
        const chapter = act.chapters.find((candidate) => candidate.id === chapterId);
        if (!chapter) continue;

        const scene: MockScene = {
          id: `scene-mobile-${chapter.scenes.length + 1}`,
          chapterId,
          sceneNumber: chapter.scenes.length + 1,
          summary: typeof body.summary === 'string' ? body.summary : 'Quick Draft',
          outline: typeof body.outline === 'string' ? body.outline : null,
          prose: typeof body.prose === 'string' ? body.prose : '',
          wordCount: countWords(typeof body.prose === 'string' ? body.prose : ''),
        };
        chapter.scenes.push(scene);
        log.createScene.push(body);
        latestTraces.set(sceneKey(bookId, scene.id), null);
        await respond({ scene }, 201);
        return;
      }

      await respond({ message: 'Chapter not found' }, 404, false);
      return;
    }

    const updateSceneMatch = pathname.match(/^\/api\/books\/([^/]+)\/scenes\/([^/]+)$/);
    if (method === 'PUT' && updateSceneMatch) {
      const bookId = decodeURIComponent(updateSceneMatch[1]);
      const sceneId = decodeURIComponent(updateSceneMatch[2]);
      const structure = structures.get(bookId);
      const context = structure ? findStructureScene(structure, sceneId) : null;

      if (!context) {
        await respond({ message: 'Scene not found' }, 404, false);
        return;
      }

      if (typeof body.summary === 'string') context.scene.summary = body.summary;
      if (typeof body.outline === 'string') context.scene.outline = body.outline;
      if (typeof body.prose === 'string') {
        context.scene.prose = body.prose;
        context.scene.wordCount = countWords(body.prose);
      }

      log.updateScene.push(body);
      await respond({ scene: context.scene });
      return;
    }

    const latestTraceMatch = pathname.match(
      /^\/api\/books\/([^/]+)\/scenes\/([^/]+)\/prose\/traces\/latest$/,
    );
    if (method === 'GET' && latestTraceMatch) {
      const bookId = decodeURIComponent(latestTraceMatch[1]);
      const sceneId = decodeURIComponent(latestTraceMatch[2]);
      await respond(latestTraces.get(sceneKey(bookId, sceneId)) ?? null);
      return;
    }

    if (method === 'POST' && pathname === '/api/generate/prose') {
      log.generate.push(body);
      await respond({
        prose: generatedProse,
        traceId: null,
        judgeStatus: 'pending',
        recipeVersion: 'mobile-v1',
        genreKey: 'fantasy',
        adapterUsed: 'mock-generator',
      });
      return;
    }

    if (method === 'POST' && pathname === '/api/generate/prose/command-revise') {
      log.commandRevise.push(body);
      await respond({
        revised: body.scope === 'paragraph' ? revisedParagraph : revisedScene,
        scope: body.scope,
        model: 'mock-mobile-reviewer',
      });
      return;
    }

    const preferenceMatch = pathname.match(
      /^\/api\/books\/([^/]+)\/scenes\/([^/]+)\/prose\/preferences$/,
    );
    if (method === 'POST' && preferenceMatch) {
      const bookId = decodeURIComponent(preferenceMatch[1]);
      const sceneId = decodeURIComponent(preferenceMatch[2]);
      log.preference.push(body);
      latestTraces.set(sceneKey(bookId, sceneId), preferenceTrace);
      await respond(preferenceTrace);
      return;
    }

    await route.continue();
  });

  return { books, structures, latestTraces, log };
}

async function installSpeechRecognitionMock(
  page: Page,
  options: { transcript?: string; error?: string },
) {
  await page.addInitScript(({ transcript, error }) => {
    class MockSpeechRecognition {
      onstart?: () => void;
      onend?: () => void;
      onerror?: (event: { error?: string }) => void;
      onresult?: (event: { results?: ArrayLike<ArrayLike<{ transcript?: string }>> }) => void;
      lang = 'en-US';
      interimResults = false;
      maxAlternatives = 1;

      start() {
        this.onstart?.();
        if (error) {
          this.onerror?.({ error });
        } else if (transcript) {
          this.onresult?.({
            results: [[{ transcript }]],
          });
        }
        this.onend?.();
      }

      stop() {
        this.onend?.();
      }
    }

    window.webkitSpeechRecognition = MockSpeechRecognition;
  }, options);
}

test.describe('Mobile Mode', () => {
  test('phone-class devices land in the mobile shell by default', async ({ page }) => {
    await installMobileApiMocks(page);

    await page.goto('/');
    await page.waitForURL('**/m');

    await expect(page.getByText('Phone-first drafting')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Home' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Studio' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Read' })).toBeVisible();
  });

  test('desktop override persists after switching out of the mobile shell', async ({
    page,
    context,
  }) => {
    await page.goto('/');
    await page.waitForURL('**/m');

    await page.getByRole('button', { name: 'Desktop' }).click();
    await expect.poll(() => new URL(page.url()).pathname.startsWith('/m')).toBe(false);

    const cookies = await context.cookies();
    const desktopCookie = cookies.find((cookie) => cookie.name === 'proser-view');
    expect(desktopCookie?.value).toBe('desktop');

    await page.goto('/');
    await expect.poll(() => new URL(page.url()).pathname.startsWith('/m')).toBe(false);
  });

  test('quick draft on an existing book creates a mobile draft scene and opens the studio', async ({
    page,
  }) => {
    const api = await installMobileApiMocks(page, {
      latestTraces: {
        [sceneKey('book-1', 'scene-1')]: null,
      },
    });

    await page.goto('/m');

    await page.getByRole('button', { name: 'Quick Draft' }).click();
    const quickDraftDialog = page.getByRole('dialog', { name: 'Quick Draft' });
    await quickDraftDialog
      .getByPlaceholder(
        'A disgraced heir sneaks back into the city the night the old wards begin to fail.',
      )
      .fill('A disgraced heir returns to the city under failing wards.');
    await quickDraftDialog
      .getByPlaceholder('Moody, intimate, and urgent')
      .fill('Tense and rain-soaked');
    await quickDraftDialog
      .getByRole('button', { name: 'Create And Open Studio' })
      .evaluate((button: HTMLButtonElement) => button.click());

    await expect(page).toHaveURL(/\/m\/studio\?bookId=book-1&sceneId=scene-mobile-1/);
    await expect(
      page.getByRole('heading', {
        name: 'A disgraced heir returns to the city under failing wards',
      }),
    ).toBeVisible();
    expect(api.log.createChapter).toHaveLength(1);
    expect(api.log.createScene).toHaveLength(1);
    expect(api.log.createChapter[0]).toMatchObject({ title: 'Mobile Drafts' });
  });

  test('quick draft can seed a brand-new book and open the mobile studio', async ({ page }) => {
    const api = await installMobileApiMocks(page, {
      latestTraces: {
        [sceneKey('book-1', 'scene-1')]: null,
      },
    });

    await page.goto('/m');

    await page.getByRole('button', { name: 'Quick Draft' }).click();
    const quickDraftDialog = page.getByRole('dialog', { name: 'Quick Draft' });
    await quickDraftDialog
      .getByRole('button', { name: 'New Book' })
      .evaluate((button: HTMLButtonElement) => button.click());
    await quickDraftDialog.getByPlaceholder('Moonlit Kingdom').fill('Moonlit Kingdom');
    await quickDraftDialog
      .getByPlaceholder(
        'A disgraced heir sneaks back into the city the night the old wards begin to fail.',
      )
      .fill('An exiled princess slips back into the citadel to steal the crown.');
    await quickDraftDialog
      .getByPlaceholder('Moody, intimate, and urgent')
      .fill('Lyrical and dangerous');
    await quickDraftDialog
      .getByRole('button', { name: 'Create And Open Studio' })
      .evaluate((button: HTMLButtonElement) => button.click());

    await expect(page).toHaveURL(/\/m\/studio\?bookId=book-new&sceneId=scene-mobile-1/);
    await expect(
      page.getByRole('heading', {
        name: 'An exiled princess slips back into the citadel to steal the crown',
      }),
    ).toBeVisible();
    expect(api.log.createBook).toHaveLength(1);
    expect(api.log.createAct).toHaveLength(1);
    expect(api.log.createChapter).toHaveLength(1);
    expect(api.log.createScene).toHaveLength(1);
  });

  test('studio and reader recover to the first available scene when the route is missing sceneId', async ({
    page,
  }) => {
    await installMobileApiMocks(page);

    await page.goto('/m/studio?bookId=book-1');
    await expect(page).toHaveURL(/\/m\/studio\?bookId=book-1&sceneId=scene-1/);
    await expect(page.getByText('Command revise')).toBeVisible();

    await page.goto('/m/read?bookId=book-1');
    await expect(page).toHaveURL(/\/m\/read\?bookId=book-1&sceneId=scene-1/);
    await expect(page.getByText('Reader mode')).toBeVisible();
  });

  test('studio can generate a draft and revise a tapped paragraph with a typed command', async ({
    page,
  }) => {
    const api = await installMobileApiMocks(page, {
      structures: {
        'book-1': buildStructure({ sceneOneProse: '' }),
      },
      latestTraces: {
        [sceneKey('book-1', 'scene-1')]: null,
      },
    });

    await page.goto('/m/studio?bookId=book-1&sceneId=scene-1');

    await expect(page.getByText('Scene brief')).toBeVisible();
    await page.getByRole('button', { name: 'Generate Draft' }).click();

    await expect(page.getByText(FIRST_PARAGRAPH)).toBeVisible();
    await expect(page.getByText(GENERATED_SECOND_PARAGRAPH)).toBeVisible();

    await page.getByText(GENERATED_SECOND_PARAGRAPH).click();
    await page
      .getByPlaceholder('Make the ending sharper and more ominous...')
      .fill('Make the lights feel actively hostile.');
    await page.getByRole('button', { name: 'Revise Draft' }).click();

    await expect(page.getByText(REVISED_PARAGRAPH)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open Reader' })).toBeVisible();
    expect(api.log.generate[0]).toMatchObject({ bookId: 'book-1', sceneId: 'scene-1' });
    expect(api.log.commandRevise[0]).toMatchObject({
      bookId: 'book-1',
      sceneId: 'scene-1',
      scope: 'paragraph',
      instruction: 'Make the lights feel actively hostile.',
      originalText: GENERATED_SECOND_PARAGRAPH,
    });
  });

  test('studio applies compare-card choices inline without desktop chrome', async ({ page }) => {
    const api = await installMobileApiMocks(page);

    await page.goto('/m/studio?bookId=book-1&sceneId=scene-1');

    await expect(page.getByText('Applyable compare cards')).toBeVisible();
    await page.getByRole('button', { name: 'Apply B' }).click();

    await expect(page.getByText(COMPARE_OPTION_B)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open Reader' })).toBeVisible();
    expect(api.log.preference[0]).toMatchObject({
      traceId: 'trace-ready-1',
      compareCardId: 7,
      chosen: 'b',
      applyChosen: true,
    });
  });

  test('reader switches between scene, chapter, and full manuscript views and exposes scene navigation controls', async ({
    page,
  }) => {
    await installMobileApiMocks(page);

    await page.goto('/m/read?bookId=book-1&sceneId=scene-1');

    await expect(page.getByText(FIRST_PARAGRAPH)).toBeVisible();
    await expect(page.getByText('Scene 1 / 3')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^Next$/ })).toBeEnabled();

    await page.getByRole('button', { name: 'Chapter' }).click();
    await expect(page.getByText('Mara heard the oath crack in the chapel.')).toBeVisible();

    await page.getByRole('button', { name: 'Full' }).click();
    await expect(
      page.getByText('The market bells kept ringing long after the fire.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Return To Studio' })).toBeVisible();
  });

  test('voice input appends dictated text when speech recognition is available', async ({
    page,
  }) => {
    await installSpeechRecognitionMock(page, { transcript: 'Make the ending colder.' });
    await installMobileApiMocks(page);

    await page.goto('/m/studio?bookId=book-1&sceneId=scene-1');

    await page.getByRole('button', { name: 'Start voice input' }).click();
    await expect(page.getByPlaceholder('Make the ending sharper and more ominous...')).toHaveValue(
      'Make the ending colder.',
    );
  });

  test('voice input shows a clear fallback when microphone access is denied', async ({ page }) => {
    await installSpeechRecognitionMock(page, { error: 'not-allowed' });
    await installMobileApiMocks(page);

    await page.goto('/m/studio?bookId=book-1&sceneId=scene-1');

    await page.getByRole('button', { name: 'Start voice input' }).click();
    await expect(page.getByText('Microphone access was denied.')).toBeVisible();
  });
});
