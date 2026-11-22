import { execFileSync } from 'node:child_process';
import path from 'node:path';

describe('Hermes Proser client safety', () => {
  const pluginDir = path.resolve(process.cwd(), 'hermes/plugins/proser-api');

  function python(source: string): Record<string, unknown> {
    return JSON.parse(execFileSync('python3', ['-c', source], { cwd: pluginDir, encoding: 'utf8' }));
  }

  it('retains confirmed Nova HTTP rejection through legacy error envelopes', () => {
    const result = python(`
import json,sys
sys.path.insert(0,'.')
import tools
class Rejected(ValueError): status=400
class Client:
    def json(self,*args): raise Rejected('Provider returned HTTP 400')
tools._NOVA_CLIENT.set(Client())
response=json.loads(tools.proser_exports({'action':'create_file','bookId':84,'body':{'format':'unsupported'}}))
print(json.dumps({'ok':response['ok'],'status':tools._NOVA_FAILURE.get().status}))
`);
    expect(result).toEqual({ ok: false, status: 400 });
  });

  it('signs a scoped audience and rejects unsafe timeout values', () => {
    const result = python(`
import base64, json, os, sys
sys.path.insert(0, '.')
import tools
os.environ['PROSER_AUTH_SECRET'] = 'test-only-secret'
os.environ['PROSER_OWNER_GITHUB_ID'] = 'iam:author'
token = tools._sign_token()
payload = json.loads(base64.urlsafe_b64decode(token.split('.')[1] + '=='))
checks = {'aud': payload['aud'], 'owner': payload['ownerGithubId'], 'read': tools._timeout({}, 'GET', '/api/books'), 'generation': tools._timeout({}, 'POST', '/api/generate/prose'), 'stream': tools._timeout({}, 'GET', '/api/test/progress-stream'), 'clamped': tools._timeout({'timeoutSeconds': 999}, 'GET', '/api/books')}
for name, value in [('boolean', True), ('infinite', float('inf'))]:
    try: tools._timeout({'timeoutSeconds': value}, 'GET', '/api/books')
    except tools.ProserClientError as exc: checks[name] = exc.code
print(json.dumps(checks))
`);
    expect(result).toEqual({ aud: 'proser-factory', owner: 'iam:author', read: 30, generation: 180, stream: 90, clamped: 600, boolean: 'INVALID_TIMEOUT', infinite: 'INVALID_TIMEOUT' });
  });

  it('bounds both declared and streamed response bodies', () => {
    const result = python(`
import io, json, os, sys
sys.path.insert(0, '.')
import tools
os.environ['PROSER_MAX_RESPONSE_BYTES'] = '1024'
class Response:
    def __init__(self, data, length=None): self.headers = {'Content-Length': str(length)} if length is not None else {}; self.data = io.BytesIO(data)
    def read(self, size=-1): return self.data.read(size)
out = {}
for name, response in [('declared', Response(b'', 1025)), ('streamed', Response(b'x' * 1025))]:
    try: tools._read_limited(response)
    except tools.ProserClientError as exc: out[name] = exc.code
print(json.dumps(out))
`);
    expect(result).toEqual({ declared: 'RESPONSE_TOO_LARGE', streamed: 'RESPONSE_TOO_LARGE' });
  });

  it('builds small full-book and immutable review workflow requests', () => {
    const result = python(`
import json, sys
sys.path.insert(0, '.')
import tools
captured = {}
def fake_request(args, method, path, **kwargs):
    captured.update({'method': method, 'path': path, 'body': kwargs.get('body'), 'idempotencyKey': kwargs.get('idempotency_key')})
    return json.dumps({'ok': True})
tools._request = fake_request
raw = tools.proser_full_book({'premise': 'A haunted archive edits the memories of everyone who reads it.', 'targetWords': 80000, 'candidateCount': 2, 'idempotencyKey': 'full-book-test-key'})
captured['fullBook'] = json.loads(raw)
tools.proser_quality_review_v1({'bookId': 33, 'model': 'critic-model', 'scopeType': 'scene', 'scopeId': 91, 'idempotencyKey': 'review-test-key'})
print(json.dumps(captured))
`);
    expect(result).toMatchObject({
      method: 'POST',
      path: '/api/workflows/quality-review',
      idempotencyKey: 'review-test-key',
      body: { bookId: 33, model: 'critic-model', scope: { type: 'scene', id: 91 } },
      fullBook: { ok: true },
    });
  });

  it('builds improvement and workflow-control bodies from flat arguments', () => {
    const result = python(`
import json, sys
sys.path.insert(0, '.')
import tools
calls = []
def fake_request(args, method, path, **kwargs):
    calls.append({'method': method, 'path': path, 'body': kwargs.get('body'), 'query': kwargs.get('query'), 'key': kwargs.get('idempotency_key')})
    return json.dumps({'ok': True})
tools._request = fake_request
tools.proser_improve_quality({'bookId': 33, 'reviewRunIds': ['11111111-1111-4111-8111-111111111111'], 'findingIds': ['22222222-2222-4222-8222-222222222222'], 'idempotencyKey': 'improve-test-key'})
tools.proser_guided_improve({'bookId': 33, 'instruction': 'Tighten the dialogue.', 'scopeType': 'scene', 'scopeId': 91, 'idempotencyKey': 'guided-test-key'})
tools.proser_workflow_status({'runId': 'run-1'})
tools.proser_workflow_checkpoint({'runId': 'run-1', 'checkpointId': 'cp-1', 'decision': 'approved'})
print(json.dumps({'calls': calls}))
`);
    expect(result.calls).toEqual([
      { method: 'POST', path: '/api/workflows/improve-quality', body: { bookId: 33, reviewRunIds: ['11111111-1111-4111-8111-111111111111'], findingIds: ['22222222-2222-4222-8222-222222222222'] }, query: null, key: 'improve-test-key' },
      { method: 'POST', path: '/api/workflows/guided-improve', body: { bookId: 33, instruction: 'Tighten the dialogue.', scope: { type: 'scene', id: 91 } }, query: null, key: 'guided-test-key' },
      { method: 'GET', path: '/api/workflows/run-1', body: null, query: null, key: null },
      { method: 'POST', path: '/api/workflows/run-1/checkpoints/cp-1/decision', body: { decision: 'approved' }, query: null, key: null },
    ]);
  });

  it('parses standards-compliant SSE incrementally across one-byte chunks', () => {
    const result = python(`
import io, json, sys
sys.path.insert(0, '.')
import tools
payload = (b': keepalive\\r\\n'
           b'id: 41\\r\\nevent: ignored\\r\\nevent: progress\\r\\n'
           b'data: {"cursor": 41,\\r\\ndata: "message": "ready"}\\r\\n\\r\\n'
           b'id: bad\\ndata: {not-json}\\n\\n'
           b'id: 42\\nevent: checkpoint\\ndata: {"nextCursor":42,"hasMore":false}\\n\\n')
class Response:
    headers = {'Content-Type': 'text/event-stream'}
    def __init__(self): self.data = io.BytesIO(payload)
    def read(self, size=-1): return self.data.read(1)
seen = []
parsed = tools._read_sse(Response(), lambda frame: seen.append({'event': frame['event'], 'id': frame['id']}))
print(json.dumps({'parsed': parsed, 'seen': seen}))
`);
    expect(result).toEqual({
      parsed: {
        events: [{ cursor: 41, message: 'ready' }],
        nextCursor: 42,
        hasMore: false,
        lastEventId: '42',
        eventIds: ['41'],
        malformedFrames: 1,
      },
      seen: [{ event: 'progress', id: '41' }, { event: 'checkpoint', id: '42' }],
    });
  });

  it('treats editorial 202 as accepted, bounds bodies, and gives stale/malformed retry guidance', () => {
    const result = python(`
import io, json, sys, urllib.error
sys.path.insert(0, '.')
import tools
calls = []
real_request = tools._request
def fake_request(args, method, path, **kwargs):
    calls.append({'method': method, 'path': path, 'body': kwargs.get('body'), 'key': kwargs.get('idempotency_key')})
    return json.dumps({'ok': True, 'status': 202, 'result': {'runId': 'run-1', 'status': 'queued'}})
tools._request = fake_request
accepted = json.loads(tools.proser_editorial_optimize({
  'bookId': 42, 'scopeType': 'chapter', 'scopeId': 17, 'passPack': 'line_edit_safe',
  'autonomy': 'safe_auto', 'protectedElements': ['Mara'], 'idempotencyKey': 'editorial-request-1'
}))
tools._request = real_request

class Headers(dict):
    def get(self, key, default=None): return super().get(key, default)
class ErrorResponse(urllib.error.HTTPError):
    def __init__(self, code, payload):
        super().__init__('https://proser/api', code, 'error', Headers({'Content-Type':'application/json'}), None)
        self.data = io.BytesIO(payload)
    def read(self, size=-1): return self.data.read(size)
def stale(*args, **kwargs):
    raise ErrorResponse(409, b'{"success":false,"error":{"code":"EDITORIAL_PROPOSAL_STALE","message":"stale"}}')
tools._urlopen = stale
tools._base_url = lambda: 'https://proser'
tools._token = lambda: 'token'
conflict = json.loads(tools._request({}, 'POST', '/api/editorial/proposals/p/apply', body={'candidateId':'c'}))

class Response:
    status = 200
    headers = Headers({'Content-Type':'application/json'})
    def __init__(self): self.data = io.BytesIO(b'{broken')
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self, size=-1): return self.data.read(size)
tools._urlopen = lambda *args, **kwargs: Response()
malformed = json.loads(tools._request({}, 'GET', '/api/editorial/pass-packs'))
print(json.dumps({'accepted': accepted, 'calls': calls, 'conflict': conflict, 'malformed': malformed, 'timeout': tools._timeout({}, 'POST', '/api/workflows/editorial-optimize')}))
`);
    expect(result).toMatchObject({
      accepted: { ok: true, status: 202, result: { runId: 'run-1', status: 'queued' } },
      calls: [{
        method: 'POST',
        path: '/api/workflows/editorial-optimize',
        body: {
          bookId: 42,
          scope: { type: 'chapter', id: 17 },
          passPack: 'line_edit_safe',
          autonomy: 'safe_auto',
          protectedElements: ['Mara'],
        },
        key: 'editorial-request-1',
      }],
      conflict: {
        ok: false,
        status: 409,
        error: {
          code: 'EDITORIAL_PROPOSAL_STALE',
          retryable: false,
          safeToRepeat: false,
        },
      },
      malformed: {
        ok: false,
        error: { code: 'MALFORMED_RESPONSE', retryable: false, safeToRepeat: true },
      },
      timeout: 180,
    });
  });
});
