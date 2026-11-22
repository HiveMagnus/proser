import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { openApiSpec } from '../api/docs/openapi';

type ContractDump = {
  schemas: Record<string, string[]>;
  routes: Record<string, Record<string, [string, string]>>;
  dedicated: Record<string, string[]>;
};

describe('Hermes plugin API contract', () => {
  it('keeps tool schemas, handlers, and route documentation in sync', () => {
    const pluginDir = path.resolve(process.cwd(), 'hermes/plugins/proser-api');
    const dumpScript = `
import importlib.util, json, pathlib, sys
sys.dont_write_bytecode = True
plugin = pathlib.Path(${JSON.stringify(pluginDir)})
def load(name):
    spec = importlib.util.spec_from_file_location(name, plugin / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
schemas = load("schemas")
tools = load("tools")
schema_actions = {}
dedicated = {}
for key, value in vars(schemas).items():
    if key.startswith("PROSER_") and isinstance(value, dict):
        name = value["name"]
        action = value["parameters"]["properties"].get("action")
        if action:
            schema_actions[name] = action["enum"]
        else:
            dedicated[name] = value["parameters"].get("required", [])
print(json.dumps({"schemas": schema_actions, "routes": tools.PLUGIN_ACTION_ROUTES, "dedicated": dedicated}, sort_keys=True))
`;
    const raw = execFileSync('python3', ['-c', dumpScript], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    const contract = JSON.parse(raw) as ContractDump;
    const documentedRoutes = new Set<string>();
    for (const [routePath, methods] of Object.entries(openApiSpec.paths ?? {})) {
      for (const method of Object.keys(methods as Record<string, unknown>)) {
        documentedRoutes.add(`${method.toUpperCase()} ${routePath}`);
      }
    }

    expect(Object.keys(contract.schemas).sort()).toEqual(Object.keys(contract.routes).sort());

    for (const [toolName, schemaActions] of Object.entries(contract.schemas)) {
      const routeActions = Object.keys(contract.routes[toolName] ?? {});
      expect(routeActions.sort()).toEqual([...schemaActions].sort());

      for (const action of schemaActions) {
        const [method, routePath] = contract.routes[toolName][action];
        const key = `${method.toUpperCase()} ${routePath}`;
        expect(documentedRoutes.has(key)).toBe(true);
      }
    }

    expect(contract.dedicated).toMatchObject({
      proser_full_book: ['premise', 'idempotencyKey'],
      proser_quality_review: ['bookId', 'model', 'idempotencyKey'],
      proser_improve_quality: ['bookId', 'reviewRunIds', 'idempotencyKey'],
      proser_guided_improve: ['bookId', 'instruction', 'idempotencyKey'],
      proser_editorial_optimize: ['bookId', 'passPack', 'autonomy', 'idempotencyKey'],
      proser_workflow_status: ['runId'],
      proser_workflow_checkpoint: ['runId', 'checkpointId', 'decision'],
      proser_workflow_pause: ['runId'],
      proser_workflow_resume: ['runId'],
      proser_workflow_cancel: ['runId'],
      proser_publication: ['runId'],
    });
  });
});
