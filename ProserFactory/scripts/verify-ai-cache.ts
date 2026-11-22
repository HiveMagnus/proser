import { databaseService } from '../src/lib/database';

async function main() {
  await databaseService.connect();
  const prisma: any = databaseService.client as any;
  const key = {
    model: 'test-model',
    recipeVersion: 'rv-test',
    promptHash: 'deadbeefcaf0',
  };
  const now = new Date();
  const value = `hello-${now.getTime()}`;
  await prisma.aICache.upsert({
    where: { model_recipeVersion_promptHash: key },
    create: { ...key, value, ttlSec: 60, lastHitAt: now },
    update: { value, lastHitAt: now },
  });
  const row = await prisma.aICache.findFirst({ where: key });
  console.log('ai_cache row:', { id: row?.id, ...key, value: row?.value?.slice(0, 40) });
  await databaseService.disconnect();
}

main().catch(err => {
  console.error('verify-ai-cache error:', err);
  process.exitCode = 1;
});
