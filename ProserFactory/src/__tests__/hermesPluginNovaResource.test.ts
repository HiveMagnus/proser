import { execFileSync } from 'node:child_process';
import path from 'node:path';

test('managed Nova tools derive only exact book or explicit new-resource fences', () => {
  const plugin = path.resolve(process.cwd(), 'hermes/plugins/proser-api');
  const script = `
import importlib.util, json, pathlib, sys
root=pathlib.Path(${JSON.stringify(plugin)})
spec=importlib.util.spec_from_file_location('proser_api',root/'__init__.py',submodule_search_locations=[str(root)])
pkg=importlib.util.module_from_spec(spec);sys.modules['proser_api']=pkg;spec.loader.exec_module(pkg)
from proser_api.nova_support import provider_resource
values={'book':provider_resource('proser_books','update_book',{'bookId':42}),'nested':provider_resource('proser_images','generate',{'body':{'bookId':43}}),'newBook':provider_resource('proser_books','create_book',{'body':{}}),'generation':provider_resource('proser_generate','title',{'bookId':44,'body':{'prompt':'x'}})}
errors=[]
for name,action,args in [('proser_workflow_cancel','',{'runId':'run-one'}),('proser_codex','update_entry',{'codexId':9,'body':{}}),('proser_editorial','apply_proposal',{'proposalId':'proposal-one'}),('proser_editorial','run_benchmark',{}),('proser_generate','title',{'body':{'prompt':'x'}})]:
 try: provider_resource(name,action,args)
 except ValueError: errors.append(name+':'+action)
print(json.dumps({'values':values,'errors':errors},sort_keys=True))
`;
  const result = JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })) as { values: Record<string, string>; errors: string[] };
  expect(result.values).toEqual({ book: '42', nested: '43', newBook: '', generation: '44' });
  expect(result.errors).toEqual(['proser_workflow_cancel:', 'proser_codex:update_entry', 'proser_editorial:apply_proposal', 'proser_editorial:run_benchmark', 'proser_generate:title']);
});

test('managed schemas require the owning book before ambiguous mutations', () => {
  const plugin = path.resolve(process.cwd(), 'hermes/plugins/proser-api');
  const script = `
import importlib.util,json,pathlib,sys
root=pathlib.Path(${JSON.stringify(plugin)})
spec=importlib.util.spec_from_file_location('proser_api',root/'__init__.py',submodule_search_locations=[str(root)])
pkg=importlib.util.module_from_spec(spec);sys.modules['proser_api']=pkg;spec.loader.exec_module(pkg)
from proser_api.nova_support import ManagedContext
class C:
 def __init__(self): self.values={}
 def register_tool(self,**kwargs): self.values[kwargs['name']]=kwargs
class T: PLUGIN_ACTION_ROUTES={}
c=C();managed=ManagedContext(c,T())
managed.register_tool(name='proser_workflow_cancel',toolset='proser_api',description='x',handler=lambda args:'{}',schema={'parameters':{'type':'object','properties':{'runId':{'type':'string'}},'required':['runId']}})
managed.register_tool(name='proser_generate',toolset='proser_api',description='x',handler=lambda args:'{}',schema={'parameters':{'type':'object','properties':{'action':{'type':'string'},'body':{'type':'object'}},'required':['action','body']}})
print(json.dumps({'workflowRequired':c.values['proser_workflow_cancel']['schema']['parameters']['required'],'book':c.values['proser_workflow_cancel']['schema']['parameters']['properties']['bookId'],'generationRequired':c.values['proser_generate']['schema']['parameters']['required']}))
`;
  const result = JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })) as { workflowRequired: string[]; generationRequired: string[]; book: unknown };
  expect(result.workflowRequired).toEqual(expect.arrayContaining(['runId', 'bookId', 'request_id', 'operation_key']));
  expect(result.generationRequired).toEqual(expect.arrayContaining(['action', 'body', 'bookId', 'request_id', 'operation_key']));
  expect(result.book).toEqual(expect.objectContaining({ type: 'integer', minimum: 1 }));
});

test('managed tools reserve GPU only for enabled synchronous inference actions', () => {
  const plugin = path.resolve(process.cwd(), 'hermes/plugins/proser-api');
  const script = `
import importlib.util,json,pathlib,sys
root=pathlib.Path(${JSON.stringify(plugin)})
spec=importlib.util.spec_from_file_location('proser_api',root/'__init__.py',submodule_search_locations=[str(root)])
pkg=importlib.util.module_from_spec(spec);sys.modules['proser_api']=pkg;spec.loader.exec_module(pkg)
from proser_api.nova_support import provider_uses_gpu
checks={
 'generate':provider_uses_gpu('proser_generate','title'),
 'image':provider_uses_gpu('proser_images','generate_flux'),
 'prompt':provider_uses_gpu('proser_images','suggest_prompt'),
 'scene':provider_uses_gpu('proser_books','regenerate_scene'),
 'documentProposal':provider_uses_gpu('proser_books','request_document_proposal'),
 'documentApply':provider_uses_gpu('proser_books','apply_document_proposal'),
 'read':provider_uses_gpu('proser_images','health',True),
 'book':provider_uses_gpu('proser_books','update_book'),
 'detached':provider_uses_gpu('proser_full_book',''),
}
print(json.dumps(checks,sort_keys=True))
`;
  const result = JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })) as Record<string, boolean>;
  expect(result).toEqual({ book: false, detached: false, documentApply: false, documentProposal: true, generate: true, image: true, prompt: true, read: false, scene: true });
});
