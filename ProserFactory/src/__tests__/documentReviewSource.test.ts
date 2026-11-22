jest.mock('@/cli/utils/output',()=>({output:{json:jest.fn(),error:jest.fn(),failSpinner:jest.fn()}}));
jest.mock('@/lib/skills',()=>({...jest.requireActual('@/lib/skills'),runSkills:jest.fn()}));
import { randomUUID } from 'node:crypto';
import { skillInputHash } from '@/lib/skills/runner';
import { runSkills } from '@/lib/skills';
import { databaseService } from '@/lib/database';
import { documentService } from '@/documents/service';
import { reviewCommand } from '@/cli/commands/review';
import { output } from '@/cli/utils/output';
import * as cliDatabase from '@/cli/utils/database';
describe('full revision-bound skill inputs and CLI ownership',()=>{
 test('changes after character2000 and exact source/style revision changes produce distinct hashes',()=>{
  const base={bookId:1,sceneId:2,prose:'x'.repeat(3000)+'original'};expect(skillInputHash(base)).not.toBe(skillInputHash({...base,prose:'x'.repeat(3000)+'changed'}));
  const proof={bookRevisionId:'book',sceneRevisionId:'scene',contentHash:'body',projection:'final' as const,projectionSha256:'projection'};expect(skillInputHash({...base,documentSource:proof})).not.toBe(skillInputHash({...base,documentSource:{...proof,contentHash:'new formatting'}}));
 });
 const db=()=>databaseService.client;let userId:number;let otherUserId:number;let bookId:number;let otherBookId:number;let sceneId:number;let foreignSceneId:number;const previous=process.env.DOCUMENT_AUTHORITY_ENABLED;
 beforeAll(async()=>{process.env.DOCUMENT_AUTHORITY_ENABLED='true';userId=(await db().user.create({data:{githubId:`review-source-${randomUUID()}`,username:'Review fixture'}})).id;otherUserId=(await db().user.create({data:{githubId:`review-foreign-${randomUUID()}`,username:'Foreign fixture'}})).id;});
 beforeEach(async()=>{
  jest.spyOn(cliDatabase,'closeDatabase').mockResolvedValue(undefined);
  const create=(owner:number)=>db().book.create({data:{userId:owner,title:'Saved title',acts:{create:{actNumber:1,chapters:{create:{chapterNumber:1,scenes:{create:{sceneNumber:1,prose:'Complete owned source 😀é.'}}}}}}},include:{acts:{include:{chapters:{include:{scenes:true}}}}}});
  const book=await create(userId);bookId=book.id;sceneId=book.acts[0].chapters[0].scenes[0].id;await documentService.initialize(userId,bookId);
  const foreign=await create(otherUserId);otherBookId=foreign.id;foreignSceneId=foreign.acts[0].chapters[0].scenes[0].id;
  jest.mocked(runSkills).mockResolvedValue({results:[],totalLatencyMs:1,totalFindings:0,severityCounts:{error:0,warning:0,suggestion:0,info:0}});
 });
 afterEach(async()=>{await db().documentLegacyRevisionMapping.deleteMany({where:{bookId}});await db().documentOperation.deleteMany({where:{bookId}});await db().bookDocumentHead.deleteMany({where:{bookId}});await db().bookDocumentRevision.deleteMany({where:{bookId}});await db().bookDocumentScopeRevision.deleteMany({where:{bookId}});await db().sceneDocumentRevision.deleteMany({where:{bookId}});await db().book.delete({where:{id:bookId}});await db().book.delete({where:{id:otherBookId}});jest.restoreAllMocks();jest.clearAllMocks();});
 afterAll(async()=>{await db().user.delete({where:{id:userId}});await db().user.delete({where:{id:otherUserId}});if(previous===undefined)delete process.env.DOCUMENT_AUTHORITY_ENABLED;else process.env.DOCUMENT_AUTHORITY_ENABLED=previous;});
 test('a foreign scene cannot be inspected through an owned book command',async()=>{
  const handler = reviewCommand.handler;
  if (typeof handler !== 'function') throw new Error('handler');
  // Node shares the underlying exit status with the Jest process.
  const setExitCode = jest.spyOn(process, 'exitCode', 'set').mockImplementation(() => {});
  try {
   await handler({_:['review'],$0:'proser',bookId,'user-id':userId,'scene-id':foreignSceneId,json:true});
   expect(setExitCode).toHaveBeenCalledWith(1);
   expect(runSkills).not.toHaveBeenCalled();
   expect(output.json).toHaveBeenLastCalledWith(expect.objectContaining({success:false}));
  } finally {
   setExitCode.mockRestore();
  }
 });
 test('review consumes the exact saved projection and discloses its document source',async()=>{
  const source=await documentService.read(userId,bookId,sceneId);const handler=reviewCommand.handler;if(typeof handler!=='function')throw new Error('handler');await handler({_:['review'],$0:'proser',bookId,'user-id':userId,'scene-id':sceneId,json:true});expect(runSkills).toHaveBeenCalledWith(expect.objectContaining({prose:source.projection.text,documentSource:{bookRevisionId:source.bookRevisionId,sceneRevisionId:source.revisionId,contentHash:source.contentHash,projection:'final',projectionSha256:expect.any(String)}}));expect(output.json).toHaveBeenLastCalledWith(expect.objectContaining({success:true,findings:[expect.objectContaining({documentSource:expect.objectContaining({sceneRevisionId:source.revisionId})})]}));
 });
});
