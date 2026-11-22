import { execFileSync } from 'node:child_process';
import path from 'node:path';
/** Tool names stay compatible while publication recovery binds to exact owned UUIDs. */
test('Hermes negotiates publication capabilities, forwards exact source options and recovers the retained job',()=>{
  const script=`import importlib.util,json,pathlib,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('tools',pathlib.Path(${JSON.stringify(path.resolve(process.cwd(),'hermes/plugins/proser-api/tools.py'))}))
tools=importlib.util.module_from_spec(spec);spec.loader.exec_module(tools)
spec=importlib.util.spec_from_file_location('schemas',pathlib.Path(${JSON.stringify(path.resolve(process.cwd(),'hermes/plugins/proser-api/schemas.py'))}))
schemas=importlib.util.module_from_spec(spec);spec.loader.exec_module(schemas)
calls=[]
def request(args,method,route,**kw):
 calls.append({'method':method,'path':route,'body':kw.get('body')});return json.dumps({'ok':True})
tools._request=request
body={'format':'markdown','operationId':'11111111-1111-4111-8111-111111111111','expectedRevisionId':'22222222-2222-4222-8222-222222222222','mode':'retain-review','preset':'saved'}
tools.proser_exports({'action':'capabilities','bookId':12})
tools.proser_exports({'action':'create_file','bookId':12,'body':body})
tools.proser_exports({'action':'get_job','bookId':12,'jobId':body['operationId']})
tools.proser_exports({'action':'get_file','bookId':12,'artifactId':'33333333-3333-4333-8333-333333333333'})
print(json.dumps({'calls':calls,'actions':schemas.PROSER_EXPORTS['parameters']['properties']['action']['enum'],'required':schemas._ACTION_REQUIRED['proser_exports']['get_job']}))`;
  const result=JSON.parse(execFileSync('python3',['-c',script],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}));
  expect(result.calls).toEqual([
    {method:'GET',path:'/api/books/12/document-publication-capabilities',body:null},
    {method:'POST',path:'/api/books/12/export-artifacts',body:{format:'markdown',operationId:'11111111-1111-4111-8111-111111111111',expectedRevisionId:'22222222-2222-4222-8222-222222222222',mode:'retain-review',preset:'saved'}},
    {method:'GET',path:'/api/books/12/document-publication-jobs/11111111-1111-4111-8111-111111111111',body:null},
    {method:'GET',path:'/api/books/12/export-artifacts/33333333-3333-4333-8333-333333333333',body:null},
  ]);
  expect(result.actions).toEqual(expect.arrayContaining(['capabilities','get_job','create_file','get_file','read_file','delete_file']));
  expect(result.required).toEqual(['bookId','jobId']);
});
