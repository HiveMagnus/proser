#!/usr/bin/env -S node
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });
import { databaseService } from '../src/lib/database/index';

async function main() {
  if (!databaseService.isReady) {
    await databaseService.connect();
  }
  const total = await databaseService.client.scene.count();
  const proseNonEmpty = await databaseService.client.scene.count({ where: { OR: [ { prose: { not: null } } ] } });
  const zeroButHasProse = await databaseService.client.scene.count({ where: { wordCount: 0, OR: [ { prose: { not: null } }, { prose: { gt: '' } } ] as any } as any });
  console.log(JSON.stringify({ total, proseNonEmpty, zeroButHasProse }, null, 2));
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
