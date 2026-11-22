import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanProjectionWrites } from './check-document-writers.mjs';
const scan = source => scanProjectionWrites(new Map([['/fixture.ts', source]]));
test('projection writes, aliases, computed keys, spreads and nested creates cannot bypass the service', () => {
  for (const source of [
    "db.scene.update({where:{id:1},data:{prose:'unsafe'}})",
    'db.scene.updateMany({data:{wordCount:0}})',
    "db['scene']['create']({data:{prose:'unsafe'}})",
    "const scene = db.scene; scene.upsert({create:{prose:'unsafe'},update:{}})",
    "const {scene:s} = db; s.create({data:{prose:'unsafe'}})",
    "const data = {}; data.prose = 'unsafe'; db.scene.update({data})",
    "const data = {}; const alias = data; alias.prose = 'unsafe'; db.scene.update({data})",
    "const data = {}; Object.assign(data,{prose:'unsafe'}); db.scene.update({data})",
    "const base = {prose:'unsafe'}; const data = {...base}; db.scene.create({data})",
    "function write(data) { db.scene.update({data}); }",
    "db.book.create({data:{acts:{create:{chapters:{create:{scenes:{create:{prose:'unsafe'}}}}}}}})",
    'db.$executeRaw`UPDATE scenes SET word_count = ${count} WHERE id = ${id}`',
  ]) assert.ok(scan(source).length > 0, source);
});
test('explicit metadata/catalog writes and ordinary prose values are permitted', () => {
  for (const source of [
    'db.scene.update({where:{id:1},data:{sceneNumber:2}})',
    "const metadata = {}; metadata.summary = 'new'; db.scene.update({data: metadata})",
    'db.scene.create({data:{chapterId:1,sceneNumber:1,outline:input.outline}})',
    "documentService.legacyWriteScene(userId,bookId,sceneId,{prose:'safe'})",
    'db.scene.findMany({select:{prose:true,wordCount:true}})',
  ]) assert.deepEqual(scan(source), [], source);
});
