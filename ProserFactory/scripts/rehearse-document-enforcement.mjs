#!/usr/bin/env node
/** Destructive only to newly allocated, named disposable databases. Never uses
 * the ambient/default database URL. Retains exact SQL, checksums and two dumps. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const connection = value('--isolated-postgres'); const record = value('--record-dir');
if (!connection || !record || !isAbsolute(record)) throw new Error('Required explicit --isolated-postgres URL and absolute --record-dir.');
const endpoint = new URL(connection);
if (endpoint.hostname !== '127.0.0.1' || endpoint.port !== '55441' || endpoint.pathname !== '/postgres') throw new Error('Only the documented isolated PostgreSQL fixture at 127.0.0.1:55441/postgres is permitted. Production requires the separate reviewed native deployment procedure.');
const container = value('--postgres-container') ?? 'proser-canvas-test-postgres';
if (!/^[a-zA-Z0-9_-]+$/.test(container)) throw new Error('Invalid fixture container name.');
mkdirSync(record, { recursive: true, mode: 0o700 });
const sql = readFileSync(resolve(root, 'deploy/document-authority/enforcement.sql'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
writeFileSync(resolve(record, 'enforcement.sql'), sql, { mode: 0o600 });
function run(program, argv, env = {}, input) {
  const result = spawnSync(program, argv, { cwd: root, env: { ...process.env, ...env }, input, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0 || result.error) { writeFileSync(resolve(record, 'failed-command.log'), Buffer.concat([result.stdout ?? Buffer.alloc(0), result.stderr ?? Buffer.alloc(0)]), { mode: 0o600 }); throw new Error(`Rehearsal command ${program} failed; inspect private record. No production database was used.`); }
  if (argv.some((item) => item === '--coverage=false')) writeFileSync(resolve(record, 'tests-stderr.log'), result.stderr, { mode: 0o600 });
  return result.stdout;
}
const database = `proser_canvas_enforce_${Date.now()}_${randomBytes(3).toString('hex')}`;
const restored = `${database}_restore`; const twice = `${database}_restore2`;
const admin = new pg.Client({ connectionString: connection }); await admin.connect();
async function create(name) { await admin.query(`CREATE DATABASE "${name}"`); }
function url(name) { const scoped = new URL(connection); scoped.pathname = `/${name}`; return scoped.toString(); }
async function summary(name) {
  const client = new pg.Client({ connectionString: url(name) }); await client.connect();
  try {
    const tables = ['release_admission_fence','release_fence_receipts','release_mutation_admissions','release_admission_bindings','audit_log','books','acts','chapters','scenes','manuscript_revisions','scene_document_revisions','scene_document_search_indexes','book_document_revisions','book_document_scope_revisions','book_document_heads','document_legacy_revision_mappings','document_operations','document_import_originals','document_import_previews','document_publication_artifacts','document_operator_effects','document_story_discussions','document_story_proposals','document_story_proposal_validations','evaluation_runs','evaluation_results','evaluation_corpus_cases'];
    const records = {};
    for (const table of tables) {
      const exists = await client.query('SELECT to_regclass($1) AS name', [table]);
      if (!exists.rows[0].name) continue;
      const rows = await client.query(`SELECT row_to_json(item) AS row FROM (SELECT * FROM "${table}" ORDER BY 1) item`);
      records[table] = { count: rows.rowCount, sha256: sha(Buffer.from(JSON.stringify(rows.rows))) };
    }
    const migrations = await client.query('SELECT migration_name,checksum,finished_at,rolled_back_at FROM _prisma_migrations ORDER BY migration_name');
    const triggers = await client.query("SELECT event_object_table,trigger_name,action_statement FROM information_schema.triggers WHERE trigger_name LIKE 'proser_document_%' ORDER BY event_object_table,trigger_name,event_manipulation");
    return { records, migrations: migrations.rows, triggers: triggers.rows };
  } finally { await client.end(); }
}
try {
  await create(database);
  const migrate = run(resolve(root, 'node_modules/.bin/prisma'), ['migrate', 'deploy'], { DATABASE_URL: url(database) });
  writeFileSync(resolve(record, 'migrate.log'), migrate, { mode: 0o600 });
  const schemaDiff=run(resolve(root,'node_modules/.bin/prisma'),['migrate','diff','--from-config-datasource','--to-schema','prisma/schema.prisma','--script'],{DATABASE_URL:url(database)});writeFileSync(resolve(record,'schema-diff.sql'),schemaDiff,{mode:0o600});if(!schemaDiff.toString().includes('-- This is an empty migration.'))throw new Error('Fresh migrated schema has drift; no destructive diff is applied.');
  // Prove the existing additive classifier still rejects this trigger SQL.
  run('python3', ['-c', "import importlib.util,pathlib; p=pathlib.Path('scripts/check-migration-compatibility.py'); s=importlib.util.spec_from_file_location('gate',p); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); assert not m.safe_additive_sql(pathlib.Path('deploy/document-authority/enforcement.sql').read_text())"]);
  const tests = run(resolve(root, 'node_modules/.bin/jest'), ['--runInBand','--coverage=false','src/__tests__/documentEnforcement.test.ts','src/__tests__/documentReleaseAdmission.test.ts','src/__tests__/documentBoundaryContinuation.test.ts','src/__tests__/documentBoundaryHistory.test.ts','src/__tests__/documentStoryReleaseEvidence.test.ts','src/__tests__/passageOperations.test.ts','src/__tests__/scopePassageTransfers.test.ts','src/__tests__/documentScopeTransfers.test.ts','src/__tests__/documentLegacyHistory.test.ts','src/__tests__/documentArchivedBackfill.test.ts','src/__tests__/documentLegacyHtml.test.ts','src/__tests__/documentOperatorEffects.test.ts','src/__tests__/documentOperatorCommands.test.ts','src/__tests__/documentCreativeWriter.test.ts','src/__tests__/documentReviewSource.test.ts','src/__tests__/documentQualityLab.test.ts','src/__tests__/documentQualityRunRecovery.test.ts','src/__tests__/documentAncillaryPreview.test.ts','src/__tests__/documentCommentAuthority.test.ts','src/__tests__/documentCommentAnchors.test.ts','src/__tests__/documentLayoutCommentAuthority.test.ts','src/__tests__/documentPendingReviewTargets.test.ts','src/__tests__/documentReadProjection.test.ts','src/__tests__/documentCommentContracts.test.ts','src/__tests__/documentSearch.test.ts','src/__tests__/documentSearchIndex.test.ts','src/__tests__/documentNamedStyleAuthority.test.ts','src/__tests__/documentAssetPreservation.test.ts','src/__tests__/documentChangeResolution.test.ts','src/__tests__/documentChangeResolutionAuthority.test.ts','src/__tests__/documentLayoutRestoration.test.ts','src/__tests__/documentReleaseReview.test.ts'], { DATABASE_URL: url(database), REDIS_URL: 'redis://127.0.0.1:56441', USE_BULLMQ: 'false' });
  writeFileSync(resolve(record, 'tests.log'), tests, { mode: 0o600 });
  const seed = `import { randomUUID } from 'node:crypto';
import { databaseService } from ${JSON.stringify(resolve(root,'src/lib/database'))};
import redis from ${JSON.stringify(resolve(root,'src/lib/redis'))};
import { documentService } from ${JSON.stringify(resolve(root,'src/documents/service'))};
async function main() {
 await databaseService.connect(); const db=databaseService.client;
 const user=await db.user.create({data:{githubId:'enforcement-retained-'+randomUUID(),username:'Disposable preserved fixture'}});
 const book=await db.book.create({data:{userId:user.id,title:'Preserved restore fixture'}});
 const act=await db.act.create({data:{bookId:book.id,actNumber:1}});
 const chapter=await db.chapter.create({data:{actId:act.id,chapterNumber:1}});
 const scenes=[]; for(const [index,prose] of ['  Unicode 😀é\\r\\n尾\\n\\n preserved  ',null,''].entries()) scenes.push(await db.scene.create({data:{chapterId:chapter.id,sceneNumber:index+1,prose}}));
 await documentService.initialize(user.id,book.id); const scene=scenes[0]; const source=await documentService.read(user.id,book.id,scene.id);
 const paragraph=source.document.blocks[0]; if(paragraph.type!=='paragraph') throw new Error('fixture'); paragraph.runs[0].style={bold:true,font:'Georgia',size:18};
 await documentService.commit(user.id,book.id,{schemaVersion:1,operationId:randomUUID(),expectedRevisionId:source.bookRevisionId,scenes:[{sceneId:scene.id,expectedRevisionId:source.revisionId,document:source.document}]});
 const before=await documentService.manifest(user.id,book.id); await documentService.initialize(user.id,book.id); await documentService.initialize(user.id,book.id); const after=await documentService.manifest(user.id,book.id);
 if(JSON.stringify(before)!==JSON.stringify(after))throw new Error('Repeated backfill changed evidence');
 const archivedAt=new Date('2026-08-03T04:05:06.000Z');const archivedBook=await db.book.create({data:{userId:user.id,title:'Preserved archived restore fixture',deletedAt:archivedAt}});const archivedAct=await db.act.create({data:{bookId:archivedBook.id,actNumber:1}});const archivedChapter=await db.chapter.create({data:{actId:archivedAct.id,chapterNumber:1}});const archivedScenes=[];for(const [index,prose] of [null,'','  Archived Unicode 😀 é preserved  '].entries())archivedScenes.push(await db.scene.create({data:{chapterId:archivedChapter.id,sceneNumber:index+1,prose,deletedAt:index===2?archivedAt:null}}));
 const archivedOptions={includeDeleted:true,source:'operator-backfill' as const};const archivedRevisionId=await documentService.initialize(user.id,archivedBook.id,archivedOptions);const archivedHead=await db.bookDocumentHead.findUniqueOrThrow({where:{bookId:archivedBook.id}});await documentService.initialize(user.id,archivedBook.id,archivedOptions);await documentService.initialize(user.id,archivedBook.id,archivedOptions);if(JSON.stringify(archivedHead)!==JSON.stringify(await db.bookDocumentHead.findUniqueOrThrow({where:{bookId:archivedBook.id}})))throw new Error('Repeated archived backfill changed evidence');
 const originals=await db.sceneDocumentRevision.findMany({where:{bookId:archivedBook.id},orderBy:{sceneId:'asc'}});if(originals.length!==3||originals.some((row,index)=>row.originalProse!==archivedScenes[index].prose))throw new Error('Archived null/empty originals changed');if((await db.book.findUniqueOrThrow({where:{id:archivedBook.id,deletedAt:{}}})).deletedAt?.toISOString()!==archivedAt.toISOString())throw new Error('Archived backfill revived a book');
 try{await documentService.manifest(user.id,archivedBook.id);throw new Error('Archived ordinary read was exposed');}catch(error){if(!(error instanceof Error)||error.name!=='NotFoundError')throw error;}
 console.log(JSON.stringify({bookId:book.id,userId:user.id,sceneIds:scenes.map(s=>s.id),revisionId:before.revisionId,archivedBookId:archivedBook.id,archivedSceneIds:archivedScenes.map(s=>s.id),archivedRevisionId}));
}
main().finally(async()=>{try{await databaseService.disconnect();}finally{redis.disconnect();}}).catch(()=>{process.exitCode=1;});`;
  const seedPath=resolve(record,'retained-fixture.ts'); writeFileSync(seedPath,seed,{mode:0o600});
  const retained=run(resolve(root,'node_modules/.bin/tsx'),[seedPath],{DATABASE_URL:url(database),REDIS_URL:'redis://127.0.0.1:56441',USE_BULLMQ:'false'});
  writeFileSync(resolve(record,'retained-fixture.log'),retained,{mode:0o600});
  const before = await summary(database);
  const firstDump = run('docker', ['exec', container, 'pg_dump','-U','postgres','-Fc',database]);
  writeFileSync(resolve(record, 'fixture.dump'), firstDump, { mode: 0o600 });
  await create(restored); run('docker', ['exec','-i',container,'pg_restore','-U','postgres','--exit-on-error','--no-owner','--no-privileges','-d',restored], {}, firstDump);
  const first = await summary(restored);
  const secondDump = run('docker', ['exec',container,'pg_dump','-U','postgres','-Fc',restored]);
  writeFileSync(resolve(record, 'restored.dump'), secondDump, { mode: 0o600 });
  await create(twice); run('docker', ['exec','-i',container,'pg_restore','-U','postgres','--exit-on-error','--no-owner','--no-privileges','-d',twice], {}, secondDump);
  const second = await summary(twice);
  if (JSON.stringify(before) !== JSON.stringify(first) || JSON.stringify(before) !== JSON.stringify(second)) throw new Error('Second restore did not preserve fixture evidence. Production remains untouched.');
  const revision = run('git',['rev-parse','HEAD']).toString().trim();
  const dirty = run('git',['status','--porcelain']).toString().trim().length > 0;
  const evidence = { schemaVersion: 1, kind: 'isolated-enforcement-rehearsal', candidateRevision: revision, dirtyWorktree: dirty, productionAuthorization: false, sqlSha256: sha(sql), firstDumpSha256: sha(firstDump), secondDumpSha256: sha(secondDump), database, restored, twice, checks: ['additive-classifier-rejection','guarded-commit','stale-writer-rejection','immutable-evidence','projection-parity','historical-consent-preservation','active-archived-backfill-originals','archive-owned-read-isolation','legacy-html-loss-consent','operator-receipt-recovery','unknown-provider-no-replay','owner-cancel-late-ack','full-review-source-hashes','structured-quality-lab-corpus','quality-lab-provider-recovery','ancillary-owned-proposals','referenced-asset-immutability','owned-scene-layout-comment-proofs','comment-review-receipt-recovery','pending-attribution-protection','bounded-immutable-read-projections','revision-bound-editorial-result-metrics','bounded-global-search-cursor-unicode-parity','durable-revision-search-index','index-recovery-idempotency','owned-named-style-graph','style-layout-source-staleness','authenticated-change-resolution-history','resolve-target-payload-protection','resolve-receipt-recovery','candidate-reviewed-legacy-schema-alignment','release-admission-cutoff','release-exact-receipt-recovery','release-queue-hold-and-prepaused-preservation','release-known-no-dispatch-vs-unknown-multieffect','release-owned-read-and-cancel-recovery','release-scoped-maintenance-recovery','qualified-insertion-join-unicode','manual-boundary-continuation','owned-historical-boundary-reedit','unsupported-hyperlink-tracking-rejection','bounded-cross-scene-transfer','paired-scope-restoration-identity-isolation','owned-story-source-and-provider-evidence','restore1','restore2'], summary: before, completedAt: new Date().toISOString() };
  writeFileSync(resolve(record,'evidence.json'), JSON.stringify(evidence,null,2)+'\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ status: 'passed', record, sqlSha256: evidence.sqlSha256, productionAuthorization: false })+'\n');
} finally { await admin.end(); }
