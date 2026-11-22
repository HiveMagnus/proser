// Smoke test: seed a user and book directly via Prisma, then call the running backend /api/generate/prose
// Usage: node backend/scripts/smoke-generate-prose.mjs [baseUrl]
// Example: node backend/scripts/smoke-generate-prose.mjs http://localhost:3001

import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load env (DATABASE_URL) from backend/.env.local if present
try {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const dotenvPath = path.resolve(__dirname, '..', '.env.local');
  const { existsSync } = await import('node:fs');
  if (existsSync(dotenvPath)) {
    const dotenv = await import('dotenv');
    dotenv.config({ path: dotenvPath });
  }
} catch {}

// Prisma client (ensure backend has run prisma generate)
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const base = process.argv[2] || `http://localhost:${process.env.PORT || '3001'}`;

function log(msg, obj) { console.log(msg, obj ?? ''); }

async function main() {
  const tag = `smoke-${Date.now()}`;
  // Seed a user and a book the backend will authorize against
  const user = await prisma.user.upsert({
    where: { githubId: tag },
    update: { username: tag },
    create: { githubId: tag, username: tag }
  });
  log('user_id=', user.id);
  const book = await prisma.book.create({ data: { userId: user.id, title: 'Smoke Book', genre: '', targetAudience: '', summary: '' } });
  log('book_id=', book.id);

  // Call backend API
  const url = `${base}/api/generate/prose`;
  const payload = { bookId: book.id, prompt: 'Write a short scene about a dragon and a lake.', selectedModel: '' };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': String(user.id),
        'x-github-id': tag,
        'x-username': tag
      },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    console.log('status=', res.status);
    console.log('body_prefix=', text.slice(0, 400));
  } catch (e) {
    console.error('request_error=', (e && e.message) || String(e));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error('smoke_failed=', e?.message || e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
