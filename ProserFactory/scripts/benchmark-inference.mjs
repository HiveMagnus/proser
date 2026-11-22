#!/usr/bin/env node

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=', 2);
  return [key, value];
}));
const baseUrl = String(args.url ?? process.env.INFERENCE_HOST ?? 'http://127.0.0.1:8000').replace(/\/+$/, '');
const model = String(args.model ?? process.env.OLLAMA_MODEL ?? 'qwen3.6-35b');
const iterations = Math.max(1, Number(args.iterations ?? 5));
const apiKey = String(process.env.INFERENCE_API_KEY ?? '').trim();
if (!apiKey) throw new Error('INFERENCE_API_KEY is required');
const inferenceHeaders = { authorization: `Bearer ${apiKey}` };

async function complete(body) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...inferenceHeaders }, body: JSON.stringify({ model, stream: false, ...body }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(data).slice(0, 500)}`);
  return { data, milliseconds: performance.now() - started };
}

function message(result) { return result.data.choices?.[0]?.message ?? {}; }
function finish(result) { return result.data.choices?.[0]?.finish_reason ?? 'unknown'; }
function usage(result) { return result.data.usage ?? {}; }
function mean(values) { return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1); }

const workflowTools = [
  ['proser_full_book', { premise: { type: 'string' }, targetWords: { type: 'integer' } }, ['premise']],
  ['proser_quality_review', { bookId: { type: 'integer' }, model: { type: 'string' }, scopeType: { type: 'string', enum: ['book', 'act', 'chapter', 'scene'] } }, ['bookId', 'model']],
  ['proser_improve_quality', { bookId: { type: 'integer' }, reviewRunIds: { type: 'array', items: { type: 'string' } } }, ['bookId', 'reviewRunIds']],
  ['proser_guided_improve', { bookId: { type: 'integer' }, instruction: { type: 'string' }, scopeType: { type: 'string', enum: ['book', 'act', 'chapter', 'scene'] }, scopeId: { type: 'integer' } }, ['bookId', 'instruction']],
  ['proser_workflow_status', { runId: { type: 'string' } }, ['runId']],
].map(([name, properties, required]) => ({ type: 'function', function: { name, description: `Use ${name} for its named Proser action.`, parameters: { type: 'object', additionalProperties: false, properties, required } } }));

const toolCases = [
  ['Run a full quality review of book 33 with qwen3.6-35b.', 'proser_quality_review'],
  ['Improve book 33 using review run 3f2504e0-4f89-41d3-9a0c-0305e82c3301.', 'proser_improve_quality'],
  ['In scene 48 of book 33, make the doorway timing unambiguous.', 'proser_guided_improve'],
  ['Get status for workflow 3f2504e0-4f89-41d3-9a0c-0305e82c3301.', 'proser_workflow_status'],
];

async function benchmarkTools() {
  let passed = 0; let total = 0; const failures = [];
  for (const [prompt, expected] of toolCases) for (let iteration = 0; iteration < iterations; iteration += 1) {
    total += 1;
    const result = await complete({
      messages: [{ role: 'system', content: 'Choose one tool and populate every field explicitly stated by the user.' }, { role: 'user', content: prompt }],
      tools: workflowTools, tool_choice: 'auto', chat_template_kwargs: { enable_thinking: false },
      temperature: 0.1, top_p: 0.85, top_k: 20, presence_penalty: 0, max_tokens: 320,
    });
    const call = message(result).tool_calls?.[0];
    let parsed = null; try { parsed = JSON.parse(call?.function?.arguments ?? ''); } catch {}
    const ok = finish(result) === 'tool_calls' && call?.function?.name === expected && parsed && Object.keys(parsed).length > 0;
    if (ok) passed += 1; else failures.push({ expected, finish: finish(result), name: call?.function?.name, arguments: call?.function?.arguments });
  }
  return { passed, total, rate: passed / total, failures: failures.slice(0, 5) };
}

const findingSchema = { type: 'object', additionalProperties: false, required: ['findings'], properties: {
  findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['severity', 'message'], properties: {
    severity: { type: 'string', enum: ['high', 'medium', 'low'] }, message: { type: 'string' },
  } } },
} };

async function benchmarkJson() {
  let passed = 0; const latencies = [];
  for (let iteration = 0; iteration < iterations * 2; iteration += 1) {
    const result = await complete({
      messages: [{ role: 'system', content: 'Return only JSON matching the supplied schema.' }, { role: 'user', content: 'Identify one clarity issue in: She walked to the door. She walked through the door. Or return an empty list.' }],
      response_format: { type: 'json_schema', json_schema: { name: 'quality_findings', strict: true, schema: findingSchema } },
      chat_template_kwargs: { enable_thinking: false }, temperature: 0.15, top_p: 0.85, top_k: 20, presence_penalty: 0, max_tokens: 256,
    });
    latencies.push(result.milliseconds);
    try { const parsed = JSON.parse(message(result).content); if (Array.isArray(parsed.findings) && finish(result) === 'stop') passed += 1; } catch {}
  }
  return { passed, total: iterations * 2, rate: passed / (iterations * 2), meanMilliseconds: mean(latencies) };
}

async function benchmarkThinking() {
  const modes = [{ name: 'off', enabled: false, budget: undefined }, { name: '256', enabled: true, budget: 256 }, { name: '768', enabled: true, budget: 768 }];
  const report = {};
  for (const mode of modes) {
    let visible = 0; let leaked = 0; const latencies = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const result = await complete({
        messages: [{ role: 'user', content: 'Explain in two sentences why a locked-room mystery needs a fair-play clue.' }],
        chat_template_kwargs: { enable_thinking: mode.enabled }, ...(mode.budget ? { thinking_budget_tokens: mode.budget } : {}),
        temperature: mode.enabled ? 0.6 : 0.2, top_p: 0.9, top_k: 20, presence_penalty: 0, max_tokens: mode.enabled ? mode.budget + 180 : 180,
      });
      const content = String(message(result).content ?? '');
      if (content.trim()) visible += 1;
      if (/<think>|I need to|We need to/i.test(content)) leaked += 1;
      latencies.push(result.milliseconds);
    }
    report[mode.name] = { visible, total: iterations, leaked, meanMilliseconds: mean(latencies) };
  }
  return report;
}

async function benchmarkConcurrency() {
  const report = {};
  for (const concurrency of [1, 4, 8]) {
    const started = performance.now();
    const results = await Promise.all(Array.from({ length: concurrency }, (_, index) => complete({
      messages: [{ role: 'user', content: `Write exactly 180 words of atmospheric prose about archive room ${index + 1}. No title.` }],
      chat_template_kwargs: { enable_thinking: false }, temperature: 0.7, top_p: 0.9, top_k: 20, presence_penalty: 1.5, max_tokens: 320, seed: 1000 + index,
    })));
    const seconds = (performance.now() - started) / 1000;
    const tokens = results.reduce((sum, result) => sum + Number(usage(result).completion_tokens ?? 0), 0);
    report[concurrency] = { wallSeconds: seconds, completionTokens: tokens, aggregateTokensPerSecond: tokens / seconds, meanRequestMilliseconds: mean(results.map((result) => result.milliseconds)) };
  }
  return report;
}

const startedAt = new Date().toISOString();
const health = await fetch(`${baseUrl}/health`, { headers: inferenceHeaders }).then((response) => response.json());
const report = {
  startedAt, baseUrl, model, iterations, health,
  tools: await benchmarkTools(), json: await benchmarkJson(), thinking: await benchmarkThinking(), concurrency: await benchmarkConcurrency(),
  finishedAt: new Date().toISOString(),
};
console.log(JSON.stringify(report, null, 2));
