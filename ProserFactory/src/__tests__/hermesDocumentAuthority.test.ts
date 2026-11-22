import { execFileSync } from 'node:child_process';
import path from 'node:path';
describe('Hermes structured writer boundary',()=>{
 test('preserves exact caller preconditions through deletes and exposes receipt recovery without refreshing source',()=>{
  const script=`import importlib.util,json,pathlib,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('tools',pathlib.Path(${JSON.stringify(path.resolve(process.cwd(),'hermes/plugins/proser-api/tools.py'))}))
tools=importlib.util.module_from_spec(spec);spec.loader.exec_module(tools)
calls=[]
def request(args,method,route,**kw):
 calls.append({'method':method,'path':route,'body':kw.get('body')});return json.dumps({'ok':True})
tools._request=request
body={'documentPreconditions':{'operationId':'save-original','expectedRevisionId':'book-original','expectedSceneRevisionId':'scene-original','expectedScopes':{'structure':'structure-original'}}}
for action,args in [('delete_scene',{'bookId':1,'sceneId':2,'body':body}),('delete_book',{'bookId':1,'body':body}),('document_operation',{'bookId':1,'operationId':'save-original'}),('document_manifest',{'bookId':1}),('scene_document',{'bookId':1,'sceneId':2}),('document_proposal',{'bookId':1,'proposalId':'retained-preview'}),('document_inference_operation',{'bookId':1,'operationId':'retained-generation'})]: tools.proser_books({'action':action,**args})
tools.proser_codex({'action':'delete_entry','codexId':3,'body':body})
print(json.dumps(calls))`;
  const calls=JSON.parse(execFileSync('python3',['-c',script],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}));
  expect(calls).toEqual([
   {method:'DELETE',path:'/api/books/1/scenes/2',body:{documentPreconditions:{operationId:'save-original',expectedRevisionId:'book-original',expectedSceneRevisionId:'scene-original',expectedScopes:{structure:'structure-original'}}}},
   {method:'DELETE',path:'/api/books/1',body:{documentPreconditions:{operationId:'save-original',expectedRevisionId:'book-original',expectedSceneRevisionId:'scene-original',expectedScopes:{structure:'structure-original'}}}},
   {method:'GET',path:'/api/books/1/document-operations/save-original',body:null},
   {method:'GET',path:'/api/books/1/document-manifest',body:null},
   {method:'GET',path:'/api/books/1/scenes/2/document',body:null},
   {method:'GET',path:'/api/books/1/document-proposals/retained-preview',body:null},
   {method:'GET',path:'/api/books/1/document-inference-operations/retained-generation',body:null},
   {method:'DELETE',path:'/api/codex/3',body:{documentPreconditions:{operationId:'save-original',expectedRevisionId:'book-original',expectedSceneRevisionId:'scene-original',expectedScopes:{structure:'structure-original'}}}},
  ]);
 });
 test('lost mutation acknowledgement is unknown and retains the original operation instead of authorizing replay',()=>{
  const script=`import importlib.util,json,pathlib,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('tools',pathlib.Path(${JSON.stringify(path.resolve(process.cwd(),'hermes/plugins/proser-api/tools.py'))}))
tools=importlib.util.module_from_spec(spec);spec.loader.exec_module(tools)
tools._base_url=lambda:'https://fixture';tools._token=lambda:'fixture-token'
def failed(*args,**kwargs):raise TimeoutError('lost acknowledgement')
tools._urlopen=failed
print(json.dumps([json.loads(tools._request({},'POST','/api/books/1/document-commits',body={'operationId':'retained-save'})),json.loads(tools._request({},'POST','/api/generate/prose/revise',body={'documentPreview':{'operationId':'retained-preview'}}))]))`;
  const result=JSON.parse(execFileSync('python3',['-c',script],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}));
  expect(result[0]).toMatchObject({ok:false,error:{code:'OPERATION_OUTCOME_UNKNOWN',retryable:false,safeToRepeat:false,operationId:'retained-save'}});
  expect(result[1]).toMatchObject({ok:false,error:{code:'OPERATION_OUTCOME_UNKNOWN',retryable:false,safeToRepeat:false,operationId:'retained-preview'}});
 });
 test('negotiates the owned disclosed preview contract before either revision action can infer',()=>{
  const script=`import importlib.util,json,pathlib,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('tools',pathlib.Path(${JSON.stringify(path.resolve(process.cwd(),'hermes/plugins/proser-api/tools.py'))}))
tools=importlib.util.module_from_spec(spec);spec.loader.exec_module(tools)
active={'schemaVersion':1,'enabled':True,'revisionPreview':'disclosed-proposal-v1','revisionSource':'immutable-manifest-v1','projection':'final'}
base={'bookId':1,'sceneId':2,'instruction':'Improve clarity','originalText':'exact saved text'}
preview={'discussionId':'retained-discussion','operationId':'retained-proposal'}
results=[]
def exercise(action,capability,body):
 calls=[]
 def request(args,method,route,**kw):
  calls.append({'method':method,'path':route,'body':kw.get('body')})
  return json.dumps(capability if method=='GET' else {'ok':True,'data':{'proposalId':'proposal-result','schemaVersion':1}})
 tools._request=request
 value=json.loads(tools.proser_generate({'action':action,'body':body}))
 results.append({'value':value,'calls':calls})
for action in ['revise_prose','command_revise','inline_suggestion','feedback']:
 exercise(action,{'ok':True,'result':active},base)
 exercise(action,{'ok':True,'result':active},{**base,'documentPreview':preview})
exercise('revise_prose',{'ok':True,'result':{**active,'revisionPreview':'unverified-contract'}},{**base,'documentPreview':preview})
exercise('revise_prose',{'ok':True,'result':{**active,'schemaVersion':2}},{**base,'documentPreview':preview})
exercise('revise_prose',{'ok':False,'status':403,'error':{'code':'FORBIDDEN'}},{**base,'documentPreview':preview})
exercise('command_revise',{'ok':True,'result':{'schemaVersion':1,'enabled':False}},base)
exercise('command_revise',{'ok':True,'result':{'schemaVersion':1,'enabled':False}},{**base,'documentPreview':preview})
print(json.dumps(results))`;
  const results=JSON.parse(execFileSync('python3',['-c',script],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}));
  for(const [index,route] of [[0,'revise'],[2,'command-revise']] as const){
   expect(results[index].value).toMatchObject({ok:false,status:428,error:{code:'DOCUMENT_PRECONDITION_REQUIRED'}});
   expect(results[index].calls).toEqual([{method:'GET',path:'/api/books/1/document-capabilities',body:null}]);
   expect(results[index+1].calls).toEqual([
    {method:'GET',path:'/api/books/1/document-capabilities',body:null},
    {method:'POST',path:`/api/generate/prose/${route}`,body:{bookId:1,sceneId:2,instruction:'Improve clarity',originalText:'exact saved text',documentPreview:{discussionId:'retained-discussion',operationId:'retained-proposal'}}},
   ]);
  }
  for(const index of [4,6]) {expect(results[index].value.status).toBe(428);expect(results[index].calls).toHaveLength(1);expect(results[index+1].calls[1].method).toBe('POST');}
  expect(results[8].value.error.code).toBe('DOCUMENT_PREVIEW_CONTRACT_UNSUPPORTED');
  expect(results[9].value.error.code).toBe('DOCUMENT_CAPABILITIES_UNAVAILABLE');
  expect(results[10].value).toMatchObject({ok:false,status:403,error:{code:'FORBIDDEN'}});
  for(const index of [8,9,10,12])expect(results[index].calls).toHaveLength(1);
  expect(results[11].calls[1]).toMatchObject({method:'POST',path:'/api/generate/prose/command-revise',body:{originalText:'exact saved text'}});
  expect(results[12].value).toMatchObject({ok:false,status:503,error:{code:'DOCUMENT_AUTHORITY_INACTIVE'}});
 });

 test('book context metadata remains bounded while explicit legacy get_book preserves prose and immutable source refs',()=>{
  const script=`import importlib.util,json,pathlib,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('tools',pathlib.Path(${JSON.stringify(path.resolve(process.cwd(),'hermes/plugins/proser-api/tools.py'))}))
tools=importlib.util.module_from_spec(spec);spec.loader.exec_module(tools)
calls=[]
scene={'id':2,'sceneNumber':1,'chapterId':3,'wordCount':17,'hasProse':True,'sourceBookRevisionId':'saved-book','sourceSceneRevisionId':'saved-scene','contentHash':'scene-hash','projection':'final'}
book={'id':1,'title':'Fixture','sourceBookRevisionId':'saved-book','contentHash':'book-hash','projection':'final','acts':[{'id':4,'actNumber':1,'chapters':[{'id':3,'chapterNumber':1,'scenes':[scene]}]}]}
def request(args,method,route,**kw):
 calls.append({'method':method,'path':route,'query':kw.get('query')});return {'ok':True,'result':book}
tools._request_obj=request
context=json.loads(tools.proser_context({'action':'book_map','bookId':1}))
withProse=json.loads(tools.proser_context({'action':'book_map','bookId':1,'query':{'maxProseChars':100}}))
def raw_request(args,method,route,**kw):request(args,method,route,**kw);return json.dumps({'ok':True})
tools._request=raw_request
tools.proser_books({'action':'get_book','bookId':1})
tools.proser_books({'action':'get_book','bookId':1,'query':{'includeProse':0}})
print(json.dumps({'context':context,'withProse':withProse,'calls':calls}))`;
  const result=JSON.parse(execFileSync('python3',['-c',script],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}));
  expect(result.calls.map((call:{query:unknown})=>call.query)).toEqual([{includeProse:0},{includeProse:1},{includeProse:1},{includeProse:0}]);
  expect(result.context.totals.words).toBe(17);expect(result.context.book.sourceBookRevisionId).toBe('saved-book');expect(result.context.acts[0].chapters[0].scenes[0]).toMatchObject({hasProse:true,wordCount:17,projection:'final',sourceSceneRevisionId:'saved-scene',contentHash:'scene-hash'});
 });

 test('global search negotiates immutable bounded cursors and never falls back to a full active prose download',()=>{
  const script=`import importlib.util,json,pathlib,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('tools',pathlib.Path(${JSON.stringify(path.resolve(process.cwd(),'hermes/plugins/proser-api/tools.py'))}))
tools=importlib.util.module_from_spec(spec);spec.loader.exec_module(tools)
results=[]
for capability in [{'schemaVersion':1,'enabled':True,'globalSearch':'manifest-cursor-v1','searchIndex':'revision-gin-v1','projection':'final'},{'schemaVersion':1,'enabled':True,'projection':'final'},{'schemaVersion':2,'enabled':True}]:
 calls=[]
 def request(args,method,route,**kw):
  calls.append({'path':route,'query':kw.get('query')})
  if route.endswith('/document-capabilities'):return {'ok':True,'result':capability}
  if route.endswith('/document-search'):return {'ok':True,'result':{'schemaVersion':1,'projection':'final','query':'Echo','sourceBookRevisionId':'source-book','sourceContentHash':'source-hash','currentBookRevisionId':'new-book','stale':True,'complete':False,'nextCursor':'next-page','scannedScenes':2,'index':'revision-gin-v1','hits':[{'id':'match-identity','sceneId':2,'sceneRevisionId':'source-scene','sceneContentHash':'scene-hash','wordCount':12,'sourceText':'Echo','from':6,'to':10,'anchors':[{'blockId':'block','runId':'run','start':6,'end':10,'sourceText':'Echo'}],'excerpt':'Echo. Echo.'}]}}
  raise Exception('Full prose download attempted')
 tools._request_obj=request
 value=json.loads(tools.proser_context({'action':'search_scenes','bookId':1,'query':{'q':'Echo','cursor':'retained-page','limit':4}}));results.append({'value':value,'calls':calls})
print(json.dumps(results))`;
  const results=JSON.parse(execFileSync('python3',['-c',script],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}));
  expect(results[0].calls).toEqual([{path:'/api/books/1/document-capabilities',query:null},{path:'/api/books/1/document-search',query:{q:'Echo',limit:4,caseSensitive:'0',cursor:'retained-page'}}]);
  expect(results[0].value).toMatchObject({ok:true,sourceBookRevisionId:'source-book',stale:true,nextCursor:'next-page',hits:[{id:2,matchId:'match-identity',sourceSceneRevisionId:'source-scene',matchExcerpt:'Echo. Echo.'}]});
  for(const result of results.slice(1)){expect(result.calls).toHaveLength(1);expect(result.value.ok).toBe(false);}
 });

});
