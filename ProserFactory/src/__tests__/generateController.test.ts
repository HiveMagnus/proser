import request from 'supertest';
import app from '../index';
import { databaseService } from '../lib/database';
import { defaultModelRouter } from '../lib/ai/router';

// Mock the external AI service by stubbing global fetch used inside VllmService.
// We keep it very simple and return different shaped responses depending on a keyword
// so controller parsing paths (JSON extraction vs line splitting) still execute.
beforeAll(() => {
  // @ts-ignore
  global.fetch = jest.fn().mockImplementation((_url: string, _opts: any) => {
    // Provide a deterministic rotating set of responses to exercise parsing branches
    const responses = [
      '{"name":"Hero","description":"Brave protagonist","traits":["Brave"],"background":"From tests"}',
      '1. Title One\n2. Title Two',
      'Act 1: Setup\nAct 2: Conflict\nAct 3: Resolution',
      'Tagline 1\nTagline 2',
      'Inline suggestion text',
      'Feedback: Looks good'
    ];
    // Simple counter
    const idx = (global as any).__fetchCallCount || 0;
    (global as any).__fetchCallCount = idx + 1;
    const response = responses[idx % responses.length];
    return Promise.resolve({ ok: true, json: async () => ({
      choices: [{ message: { content: response } }],
      model: 'test',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    }) });
  });
});

async function seedUser(tag: string) {
  return databaseService.client.user.upsert({
    where: { githubId: tag },
    update: { username: tag },
    create: { githubId: tag, username: tag }
  });
}

const auth = (userId: number, tag: string) => (r: request.Test) => r
  .set('x-user-id', String(userId))
  .set('x-github-id', tag)
  .set('x-username', tag);

describe('GenerateController selected endpoints + negatives', () => {
  let user1: number; let user2: number; let book1: number; let book2: number;

  beforeAll(async () => {
    user1 = (await seedUser('jest-gen-1')).id;
    user2 = (await seedUser('jest-gen-2')).id;
  });

  it('full generate flow across endpoints with negatives & validation', async () => {
    // create books
    const b1 = await auth(user1, 'jest-gen-1')(request(app).post('/api/books')).send({ title: 'B1', genre: '', targetAudience: '', summary: '' });
    expect(b1.status).toBe(201); book1 = b1.body.data.id;
    const b2 = await auth(user2, 'jest-gen-2')(request(app).post('/api/books')).send({ title: 'B2', genre: '', targetAudience: '', summary: '' });
    expect(b2.status).toBe(201); book2 = b2.body.data.id;

    // negative ownership: character gen with foreign book
    const forbiddenChar = await auth(user1, 'jest-gen-1')(request(app).post('/api/generate/character')).send({ bookId: book2, prompt: 'Hero', selectedModel: 'test' });
    expect([403,404]).toContain(forbiddenChar.status); // depending on controller logic

  // character generation valid
    const charGen = await auth(user1, 'jest-gen-1')(request(app).post('/api/generate/character')).send({ bookId: book1, prompt: 'Hero', selectedModel: 'test' });
    expect(charGen.status).toBeLessThan(500);
  expect(charGen.body.success).toBe(true);

  // location generation
  const locGen = await auth(user1, 'jest-gen-1')(request(app).post('/api/generate/location')).send({ bookId: book1, prompt: 'A city', selectedModel: 'test' });
  expect(locGen.status).toBe(200);

  // item generation
  const itemGen = await auth(user1, 'jest-gen-1')(request(app).post('/api/generate/item')).send({ bookId: book1, prompt: 'A magic sword', selectedModel: 'test' });
  expect(itemGen.status).toBe(200);

    // outline generation (no ownership book needed, uses context)
    const outline = await auth(user1, 'jest-gen-1')(request(app).post('/api/generate/outline')).send({
      context: 'Epic tale',
      numberOfActs: 3,
      chaptersPerAct: 2,
      prompt: 'Create a detailed story outline for "Untitled" (Genre: General). Format as a well-structured outline in Markdown.',
      selectedModel: 'test'
    });
    expect(outline.status).toBeLessThan(500);

  // title generation (no book id)
    const titleGen = await auth(user1, 'jest-gen-1')(request(app).post('/api/generate/title')).send({
      genre: 'Fantasy',
      summary: 'A journey',
      prompt: 'Generate 5 compelling book titles for a Fantasy book with this summary: A journey. Format as a numbered list.',
      selectedModel: 'test'
    });
    expect(titleGen.status).toBeLessThan(500);
  expect(Array.isArray(titleGen.body.data)).toBe(true);

  // tagline generation
  const tagGen = await auth(user1, 'jest-gen-1')(request(app).post('/api/generate/tagline')).send({
    title: 'My Book',
    genre: 'Fantasy',
    summary: 'Adventure',
    prompt: 'Generate 3 compelling taglines for the book "My Book" (Genre: Fantasy). Summary: Adventure. Format as a numbered list.',
    selectedModel: 'test'
  });
  expect(tagGen.status).toBe(200);

  // inline suggestion generation
  const inline = await auth(user1, 'jest-gen-1')(request(app).post('/api/generate/inline-suggestion')).send({ bookId: book1, context: 'Some paragraph needing continuation', selectedModel: 'test' });
  expect(inline.status).toBe(200);

  // feedback generation
  const feedback = await auth(user1, 'jest-gen-1')(request(app).post('/api/generate/feedback')).send({ content: 'Provide constructive writing feedback on the following content.\n\nSample prose\n\nStructure as strengths, areas for improvement, suggestions, and overall assessment.', feedbackType: 'style', selectedModel: 'test' });
  expect(feedback.status).toBe(200);

  // summary generation
  const summaryGen = await auth(user1, 'jest-gen-1')(request(app).post('/api/generate/summary')).send({ bookId: book1, prompt: 'Summarize', selectedModel: 'test' });
  expect(summaryGen.status).toBe(200);

  // structure generation valid
    const structGen = await auth(user1, 'jest-gen-1')(request(app).post('/api/generate/structure')).send({
      bookId: book1,
      numberOfActs: 2,
      chaptersPerAct: 3,
      prompt: 'Create a detailed book structure for "B1" (Genre: ).\n\nStructure requirements:\n- 2 acts\n- 3 chapters per act\n\nProvide a comprehensive structure including:\n1. Act breakdown with themes and goals\n2. Chapter structure with:\n   - Suggested word count ranges\n   - Key plot points\n   - Character arcs\n   - Pacing notes\n\nFormat as JSON with acts array containing chapters array.',
      selectedModel: 'test'
    });
    expect(structGen.status).toBeLessThan(500);

    // validation failure: missing required field
  const badTitle = await auth(user1, 'jest-gen-1')(request(app).post('/api/generate/title')).send({ genre: 'Fantasy', summary: '', selectedModel: 'test' });
  expect(badTitle.status).toBe(422);

  // validation failure: missing bookId for character
  const badChar = await auth(user1, 'jest-gen-1')(request(app).post('/api/generate/character')).send({ prompt: 'No book id', selectedModel: 'test' });
  expect(badChar.status).toBe(422);

  const commandRevise = await auth(user1, 'jest-gen-1')(request(app).post('/api/generate/prose/command-revise')).send({
    bookId: book1,
    sceneId: 123,
    originalText: 'The corridor was dark.',
    instruction: 'Make it more ominous.',
    scope: 'scene',
    selectedModel: 'test',
  });
  expect(commandRevise.status).toBe(200);
  expect(typeof commandRevise.body.data.revised).toBe('string');
  expect(commandRevise.body.data.scope).toBe('scene');

  const missingInstruction = await auth(user1, 'jest-gen-1')(request(app).post('/api/generate/prose/command-revise')).send({
    bookId: book1,
    originalText: 'The corridor was dark.',
    scope: 'paragraph',
    selectedModel: 'test',
  });
  expect(missingInstruction.status).toBe(422);

  const foreignBookRevise = await auth(user1, 'jest-gen-1')(request(app).post('/api/generate/prose/command-revise')).send({
    bookId: book2,
    originalText: 'The corridor was dark.',
    instruction: 'Sharpen the ending.',
    scope: 'scene',
    selectedModel: 'test',
  });
  expect([403, 404]).toContain(foreignBookRevise.status);
  });

  it('does not create costly generation work through a GET URL', async () => {
    const choose = jest.spyOn(defaultModelRouter, 'choose');
    const response = await auth(user1, 'jest-gen-1')(
      request(app).get('/api/generate/stream').query({ prompt: 'private manuscript prompt' }),
    );
    expect(response.status).toBe(404);
    expect(choose).not.toHaveBeenCalled();
    choose.mockRestore();
  });
});
