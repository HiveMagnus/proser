import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  EXPENSIVE_ROUTE_LIMITS,
  GENERATION_RATE_LIMITS,
  METRICS_AUTH_FAILURE_LIMIT,
  METRICS_AUTH_FAILURE_WINDOW_SEC,
} from '../src/api/contracts/routeLimits';
import { openApiSpec } from '../src/api/docs/openapi';

type JsonRecord = Record<string, unknown>;

const outputPath = resolve(__dirname, '../../PROSER_API.generated.md');
const check = process.argv.includes('--check');

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function normalizedContractPath(path: string): string {
  return path.replace(/^\/api\/editorial-runs(?=\/|$)/, '/api/editorial/runs');
}

function securitySummary(operation: JsonRecord): string {
  const security = Array.isArray(operation.security) ? operation.security : [];
  if (!security.length) return 'Public';
  const names = security.flatMap((entry) => Object.keys(record(entry)));
  return names.map((name) => ({
    bearerAuth: 'Bearer JWT',
    internalSecret: 'Internal secret',
    metricsToken: 'Metrics token',
  })[name] ?? name).join(' or ');
}

function schemaSummary(schemaValue: unknown): string {
  const schema = record(schemaValue);
  if (typeof schema.$ref === 'string') return schema.$ref.split('/').at(-1) ?? 'JSON';
  const properties = Object.keys(record(schema.properties));
  if (properties.length) {
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const fields = properties.slice(0, 8).map((name) => required.has(name) ? name : `${name}?`);
    return `JSON: ${fields.join(', ')}${properties.length > fields.length ? ', …' : ''}`;
  }
  if (schema.type === 'array') return `JSON array of ${schemaSummary(schema.items)}`;
  return 'JSON';
}

function requestBodySummary(operation: JsonRecord): string {
  const requestBody = record(operation.requestBody);
  const content = record(requestBody.content);
  const json = record(content['application/json']);
  if (!Object.keys(json).length) return '—';
  return schemaSummary(json.schema);
}

const rateLimitByRoute = new Map<string, string>(
  Object.values(GENERATION_RATE_LIMITS).map((contract) => [
    `${contract.method} ${contract.path}`,
    `${contract.limit}/${contract.windowSec}s per user`,
  ]),
);
for (const contract of Object.values(EXPENSIVE_ROUTE_LIMITS)) {
  const scopes = [
    `${contract.dailyPerUser}/day per user`,
    contract.dailyPerBook > 0 ? `${contract.dailyPerBook}/day per book` : undefined,
    `${contract.userConcurrency} concurrent per user`,
    contract.bookConcurrency > 0 ? `${contract.bookConcurrency} concurrent per book` : undefined,
    `${contract.maxPayloadBytes}B payload`,
    `${contract.timeoutMs}ms execution`,
  ].filter(Boolean);
  rateLimitByRoute.set(`${contract.method} ${contract.path}`, scopes.join('; '));
}
rateLimitByRoute.set('POST /api/metrics/ingest', '60/60s per IP');
rateLimitByRoute.set(
  'GET /api/metrics',
  `${METRICS_AUTH_FAILURE_LIMIT}/${METRICS_AUTH_FAILURE_WINDOW_SEC}s failed auth attempts per IP`,
);

const spec = record(openApiSpec);
const info = record(spec.info);
const rows: string[] = [];
const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);
const normalizedOperations = new Map<string, {
  method: string;
  path: string;
  operation: JsonRecord;
  metadata: string;
}>();
for (const [path, pathItemValue] of Object.entries(record(spec.paths)).sort(([left], [right]) => left.localeCompare(right))) {
  const pathItem = record(pathItemValue);
  for (const method of Object.keys(pathItem).filter((name) => methods.has(name)).sort()) {
    const operation = record(pathItem[method]);
    const upperMethod = method.toUpperCase();
    const normalizedPath = normalizedContractPath(path);
    const key = `${upperMethod} ${normalizedPath}`;
    const metadata = JSON.stringify(operation);
    const existing = normalizedOperations.get(key);
    if (existing) {
      if (existing.metadata !== metadata) {
        throw new Error(
          `Conflicting normalized route metadata for ${key}: ${existing.path} and ${path}`,
        );
      }
      continue;
    }
    normalizedOperations.set(key, { method: upperMethod, path: normalizedPath, operation, metadata });
  }
}
for (const { method, path, operation } of [...normalizedOperations.values()]
  .sort((left, right) => left.path.localeCompare(right.path) || left.method.localeCompare(right.method))) {
    rows.push([
      method,
      `\`${path}\``,
      securitySummary(operation),
      requestBodySummary(operation),
      rateLimitByRoute.get(`${method} ${path}`) ?? 'No route-specific limit',
      typeof operation.summary === 'string' ? operation.summary : '',
    ].map((cell) => escapeCell(cell)).join(' | '));
}

const generated = `# Proser API generated contract

> Generated from the Factory OpenAPI/Zod route contract. Do not edit this file directly.

- Contract version: \`${String(info.version ?? 'unknown')}\`
- OpenAPI version: \`${String(spec.openapi ?? 'unknown')}\`
- Runtime JSON contract: \`GET /api/docs.json\`

The rate-limit column is sourced from the same constants used by rate-limited runtime routes. Alias paths are normalized and deduplicated; generation fails if aliases disagree on route metadata. “No route-specific limit” means authentication, ownership, body-size, queue, and global ingress controls may still apply.

| Method | Path | Authentication | JSON request body | Rate limit | Summary |
| ------ | ---- | -------------- | ----------------- | ---------- | ------- |
${rows.map((row) => `| ${row} |`).join('\n')}
`;

async function main(): Promise<void> {
  if (check) {
    const current = await readFile(outputPath, 'utf8').catch(() => '');
    if (current !== generated) {
      throw new Error('PROSER_API.generated.md is stale; run npm run docs:generate');
    }
    console.log(`Verified generated API contract (${rows.length} operations).`);
  } else {
    await writeFile(outputPath, generated);
    console.log(`Generated API contract with ${rows.length} operations.`);
  }
}

void main();
