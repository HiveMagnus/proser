"""Optional Nova boundary around the existing Proser implementation."""
import base64
import copy
import json
from pathlib import Path
import re
from urllib.parse import quote, urlencode
from .nova_bridge import nova

LAUNCHES = {'proser_full_book','proser_quality_review','proser_improve_quality','proser_guided_improve','proser_editorial_optimize'}
BOOK_SCOPED_MUTATIONS = {
    'proser_workflow_pause', 'proser_workflow_resume', 'proser_workflow_cancel',
    'proser_workflow_checkpoint', 'proser_workflow_finalize', 'proser_finding_decide',
    'proser_generate',
}
ACTION_BOOK_SCOPED_MUTATIONS = {
    'proser_codex': {'update_entry'},
    'proser_editorial': {'record_preference', 'apply_proposal'},
    'proser_images': {'suggest_prompt', 'generate', 'generate_flux'},
}
UNBOUND_MUTATIONS = {
    ('proser_books', 'create_book'),
    ('proser_full_book', ''),
}
GPU_MUTATIONS = {
    'proser_books': {'regenerate_scene', 'request_document_proposal'},
    'proser_generate': {
        'character', 'location', 'item', 'codex', 'outline', 'summary', 'title',
        'tagline', 'inline_suggestion', 'feedback', 'structure', 'prose',
        'batch_prose', 'revise_prose', 'command_revise',
    },
    'proser_images': {'suggest_prompt', 'generate', 'generate_flux'},
}


def provider_resource(name, action, args, read=False):
    """Return the exact book identity used by central provider fencing."""
    body = args.get('body') if isinstance(args.get('body'), dict) else {}
    direct, nested = args.get('bookId'), body.get('bookId')
    if direct is not None and nested is not None and direct != nested:
        raise ValueError('Nova Proser bookId declarations disagree')
    value = direct if direct is not None else nested
    if value is not None:
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise ValueError('Nova Proser bookId must be a positive integer')
        return str(value)
    if read:
        return ''
    if (name, action) in UNBOUND_MUTATIONS:
        return ''
    raise ValueError('Nova Proser mutation requires the exact owning bookId before central reserve')


def provider_uses_gpu(name, action, read=False):
    """Reserve shared GPU capacity only for enabled synchronous inference."""
    return not read and action in GPU_MUTATIONS.get(name, set())


class ManagedContext:
    def __init__(self, ctx, tools):
        self.ctx, self.tools = ctx, tools

    def __getattr__(self, name):
        return getattr(self.ctx, name)

    def register_tool(self, **kwargs):
        original, name = kwargs['handler'], kwargs['name']
        schema = copy.deepcopy(kwargs['schema'])
        schema['parameters']['properties'].update({'request_id':{'type':'string'},'operation_key':{'type':'string'}})
        schema['parameters'].setdefault('required', []).extend(['request_id','operation_key'])
        if name in BOOK_SCOPED_MUTATIONS:
            schema['parameters']['properties']['bookId'] = {'type':'integer','minimum':1,'description':'Exact owning Proser book used for central fencing.'}
            if 'bookId' not in schema['parameters']['required']:
                schema['parameters']['required'].append('bookId')
        if name in ACTION_BOOK_SCOPED_MUTATIONS:
            schema['parameters']['properties'].setdefault('bookId', {'type':'integer','minimum':1,'description':'Exact owning Proser book used for central fencing.'})
            schema['parameters'].setdefault('allOf', []).append({
                'if': {'properties': {'action': {'enum': sorted(ACTION_BOOK_SCOPED_MUTATIONS[name])}}},
                'then': {'required': ['bookId']},
            })
        def handler(args, **extra):
            sdk = nova()
            client = sdk.client.Client('proser')
            action = args.get('action','')
            route = self.tools.PLUGIN_ACTION_ROUTES.get(name,{}).get(action)
            read = route is not None and route[0] == 'GET'
            read = read or name in {'proser_context','proser_workflow_status','proser_publication','proser_workflow_evidence','proser_review_findings','proser_download'}
            if name == 'proser_models':
                read = action in {'list','status'}
            if name == 'proser_settings' or (route and route[0] == 'DELETE'):
                return json.dumps({'ok':False,'error':'Administrative settings and deletion are not part of Nova content tools'})
            clean = {k:v for k,v in args.items() if k not in {'request_id','operation_key'}}
            if name in {'proser_generate', 'proser_images'} and not read:
                clean.setdefault('body', {})['bookId'] = clean['bookId']
            def invoke(headers):
                token = self.tools._NOVA_CLIENT.set(client)
                header_token = self.tools._NOVA_HEADERS.set(headers)
                failure_token = self.tools._NOVA_FAILURE.set(None)
                try:
                    if name in LAUNCHES:
                        clean['idempotencyKey'] = headers['Idempotency-Key']
                    result = original(clean, **extra)
                    if isinstance(result,str):
                        result = json.loads(result)
                    # Existing tool handlers convert failures to envelopes. Unknown
                    # network failures must keep the journal's mutation lock.
                    if result.get('ok') is False:
                        failure = self.tools._NOVA_FAILURE.get()
                        if failure is not None:
                            raise failure
                        raise ValueError('Proser did not return a successful operation; inspect provider state')
                    data = result.get('result', result.get('data',result))
                    if name in LAUNCHES and isinstance(data,dict):
                        run_id = data.get('runId') or data.get('id')
                        if run_id:
                            result['nova_tracking'] = {'path':'/api/workflows/'+str(run_id),'cancel_path':'/api/workflows/'+str(run_id)+'/cancel','state_path':['data','status']}
                    return result
                finally:
                    self.tools._NOVA_CLIENT.reset(token)
                    self.tools._NOVA_HEADERS.reset(header_token)
                    self.tools._NOVA_FAILURE.reset(failure_token)
            try:
                return json.dumps(sdk.runtime.perform(args,'proser',name+(':'+action if action else ''),invoke,
                    mutating=not read,resource=provider_resource(name,action,args,read),gpu=provider_uses_gpu(name,action,read),
                    revision=name in {'proser_improve_quality','proser_guided_improve','proser_editorial_optimize'}))
            except (ValueError,KeyError,OSError) as exc:
                return json.dumps({'ok':False,'error':str(exc)})
        self.ctx.register_tool(**{**kwargs,'schema':schema,'handler':handler})


def safe_id(value):
    if not re.fullmatch(r'[A-Za-z0-9._-]{1,160}',str(value)):
        raise ValueError('Invalid resource identifier')
    return quote(str(value),safe='')


def register_extra(ctx, tools):
    def evidence(args, **kwargs):
        run = safe_id(args['runId'])
        part = args['part']
        if part not in {'events','checkpoints','artifacts','checkpoint'}:
            raise ValueError('Invalid workflow evidence part')
        path = '/api/workflows/'+run+'/'+('checkpoints/'+safe_id(args['checkpointId']) if part=='checkpoint' else part)
        query = {'limit': 100} if part=='events' else {'offset':args.get('offset',0),'limit':16384} if part=='checkpoint' else None
        return tools._request(args,'GET',path,query=query)
    def finalize(args, **kwargs):
        return tools._request(args,'POST','/api/workflows/'+safe_id(args['runId'])+'/finalize',body={})
    def findings(args, **kwargs):
        return tools._request(args,'GET','/api/books/'+safe_id(args['bookId'])+'/findings',query={'limit':50,**{k:args[k] for k in ('state','cursor','severity') if k in args}})
    def finding_decide(args, **kwargs):
        return tools._request(args,'PATCH','/api/findings/'+safe_id(args['findingId']),body=args['body'])
    def download(args, **kwargs):
        client = tools._NOVA_CLIENT.get()
        kind = args['kind']
        if kind == 'export':
            path = '/api/books/'+safe_id(args['bookId'])+'/export-artifacts/'+safe_id(args['artifactId'])+'/download'
        elif kind == 'publication':
            path = '/api/workflows/'+safe_id(args['runId'])+'/publication/'+safe_id(args['filename'])
        elif kind == 'image':
            path = '/api/images/'+safe_id(args['imageId'])+'/content'
        elif kind == 'creative_package':
            path = '/api/books/'+safe_id(args['bookId'])+'/creative-package'
        else:
            raise ValueError('Invalid download kind')
        downloaded = client.download(path,args['filename'],tools._NOVA_HEADERS.get(),args.get('sha256'))
        return {**downloaded, 'book_id':args.get('bookId'), 'image_id':args.get('imageId'),
                'artifact_id':args.get('artifactId'), 'workflow_id':args.get('runId'),
                'revision':args.get('artifactId') or downloaded['sha256'], 'visibility':'private'}
    def image_import(args, **kwargs):
        client = tools._NOVA_CLIENT.get()
        file = Path(args['path'])
        if file.is_symlink() or not file.resolve().is_relative_to((client.home/'cache').resolve()):
            raise ValueError('Import only a verified cache artifact')
        if file.stat().st_size > 6*1024*1024:
            raise ValueError('Native illustration exceeds 6 MiB; use an appropriate bounded derivative')
        body = {**args['body'],'bytesBase64':base64.b64encode(file.read_bytes()).decode()}
        return tools._request(args,'POST','/api/images/import',body=body)
    definitions = [
        ('proser_review_findings','Read bounded revision-bound quality findings before editorial decisions.',findings,
         {'bookId':{'type':'integer'},'state':{'type':'string','enum':['open','implemented','verified','waived','stale','all']},'cursor':{'type':'string'},'severity':{'type':'string','enum':['critical','high','medium','low']}},['bookId']),
        ('proser_finding_decide','Record a reviewed finding waiver with a specific reason. Implementation status is owned by improvement workflows.',finding_decide,
         {'bookId':{'type':'integer'},'findingId':{'type':'string'},'body':{'type':'object','properties':{'waived':{'type':'boolean'},'waiverReason':{'type':'string'}},'additionalProperties':False}},['bookId','findingId','body']),
        ('proser_workflow_evidence','Read bounded durable events, checkpoint proposals or workflow artifacts.',evidence,
         {'runId':{'type':'string'},'part':{'type':'string','enum':['events','checkpoints','artifacts','checkpoint']},'checkpointId':{'type':'string'},'offset':{'type':'integer','minimum':0}},['runId','part']),
        ('proser_workflow_finalize','Approve the ready final application release under delegated author authority after reviewing gates.',finalize,{'runId':{'type':'string'},'bookId':{'type':'integer','minimum':1}},['runId','bookId']),
        ('proser_download','Download and hash an authenticated export, publication, image or illustrated native package.',download,
         {'kind':{'type':'string','enum':['export','publication','image','creative_package']},'bookId':{'type':'integer'},'artifactId':{'type':'string'},'runId':{'type':'string'},'imageId':{'type':'integer'},'filename':{'type':'string'},'sha256':{'type':'string'}},['kind','filename']),
        ('proser_import_image','Attach verified map/art bytes natively to a shared book with source revision, digest, visibility, license and provenance.',image_import,
         {'path':{'type':'string'},'body':{'type':'object','description':'bookId, source (proser_maps/pixelfactory/nova), sourceId, sourceRevision, artifactKey, sha256, visibility, license, provenance, optional caption/setCover/expectedPreviousDigest.'}},['path','body']),
    ]
    for name, description, handler, properties, required in definitions:
        ctx.register_tool(name=name,toolset='proser_api',description=description,handler=handler,
                          schema={'name':name,'description':description,'parameters':{'type':'object','properties':properties,'required':required,'additionalProperties':False}})
