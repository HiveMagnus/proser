import {z} from 'zod';
import {sceneCommentRevalidation,sceneCommentResolution,layoutCommentRevalidation,layoutCommentResolution} from '@/api/schemas/documentComments';
import type {SceneCommentRevalidationRequest,SceneCommentResolutionRequest,LayoutStoryCommentRevalidationRequest,LayoutStoryCommentResolutionRequest} from '@/documents/comment-review-model';
// Assignability is checked in both directions so schema outputs cannot drift
// from the generated browser request contracts.
const schemas:[z.ZodType<SceneCommentRevalidationRequest>,z.ZodType<SceneCommentResolutionRequest>,z.ZodType<LayoutStoryCommentRevalidationRequest>,z.ZodType<LayoutStoryCommentResolutionRequest>]=[sceneCommentRevalidation,sceneCommentResolution,layoutCommentRevalidation,layoutCommentResolution];
const scene:SceneCommentResolutionRequest={} as z.infer<typeof sceneCommentResolution>;
const layout:LayoutStoryCommentResolutionRequest={} as z.infer<typeof layoutCommentResolution>;
describe('Factory and generated comment review contract parity',()=>{
 test('scene and layout review require exact source refs, stable operation ids and explicit actions',()=>{
  expect(scene).toEqual({});expect(layout).toEqual({});
  const revision='00000000-0000-4000-8000-000000000001';const sceneSource={expectedRevisionId:revision,expectedSceneRevisionId:revision};const layoutSource={expectedRevisionId:revision,expectedLayoutRevisionId:revision};
  expect(schemas[0].parse(sceneSource)).toEqual(sceneSource);expect(schemas[2].parse(layoutSource)).toEqual(layoutSource);
  expect(schemas[1].parse({...sceneSource,operationId:revision,action:'resolved'})).toEqual({...sceneSource,operationId:revision,action:'resolved'});
  expect(schemas[3].parse({...layoutSource,operationId:revision,action:'reopened'})).toEqual({...layoutSource,operationId:revision,action:'reopened'});
  for(const schema of schemas)expect(schema.safeParse({}).success).toBe(false);
  expect(schemas[1].safeParse({...sceneSource,operationId:revision,action:'accepted'}).success).toBe(false);
  expect(schemas[0].safeParse({...sceneSource,sourceSceneRevisionId:'fabricated-history'}).success).toBe(false);
  expect(schemas[3].safeParse({...layoutSource,operationId:revision,action:'reanchored',anchors:[{blockId:'stable',runId:'run',start:0,end:0,sourceText:''}]}).success).toBe(true);
 });
});
