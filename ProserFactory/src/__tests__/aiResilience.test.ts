import { ModelRouter } from '@/lib/ai/router';
import { InferenceTerminalError, TERMINAL_REASON_POLICIES, VllmService } from '../lib/ai/vllm';

describe('AI resilience: AJV validation + circuit breaker', () => {
  const realFetch = global.fetch as any;
  const realCaptureFlag = process.env.AI_CAPTURE_REASONING_ENABLED;
  const realInferenceBackend = process.env.INFERENCE_BACKEND;
  const realBaseUrl = process.env.OLLAMA_BASE_URL;

  afterEach(() => {
    jest.useRealTimers();
    if (typeof realCaptureFlag === 'undefined') {
      delete process.env.AI_CAPTURE_REASONING_ENABLED;
    } else {
      process.env.AI_CAPTURE_REASONING_ENABLED = realCaptureFlag;
    }
    if (typeof realInferenceBackend === 'undefined') {
      delete process.env.INFERENCE_BACKEND;
    } else {
      process.env.INFERENCE_BACKEND = realInferenceBackend;
    }
    if (typeof realBaseUrl === 'undefined') {
      delete process.env.OLLAMA_BASE_URL;
    } else {
      process.env.OLLAMA_BASE_URL = realBaseUrl;
    }
    // @ts-ignore restore
    global.fetch = realFetch;
  });

  it('falls back gracefully when AJV validation fails (character)', async () => {
    // Mock fetch to return empty JSON body that fails schema validation
    // @ts-ignore
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{}' } }],
        model: 'test',
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      })
    });

  const ai = new VllmService('test');
  const result = await ai.generateCharacter('Create a character JSON with name and description.');
    expect(result).toBeTruthy();
    // Fallback name is set when validation fails
    expect((result as any).name).toBe('Generated Character');
    expect(typeof (result as any).description).toBe('string');
  });

  it('opens circuit after repeated failures and allows recovery after window', async () => {
    // First: force 3 failures to open circuit
    let calls = 0;
    // @ts-ignore
    global.fetch = jest.fn().mockImplementation(() => {
      calls++;
      return Promise.reject(new Error('network down'));
    });

    const ai = new VllmService('test');

    // Trigger makeRequest via generateText
    await expect(ai.generateText({ prompt: 'hello' })).rejects.toThrow('AI generation failed (model: test): network down');
    expect(calls).toBeGreaterThanOrEqual(3);

    // Immediately next call should trip the open circuit
    await expect(ai.generateText({ prompt: 'hello again' })).rejects.toThrow('temporarily unavailable');

    // Close the circuit by simulating time passage
    // @ts-ignore access private breaker for test control
    (ai as any).breakerOpenUntil = Date.now() - 1;

    // Now make fetch succeed
    // @ts-ignore
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok' } }],
        model: 'test',
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      })
    });

    const ok = await ai.generateText({ prompt: 'recover' });
    expect(ok).toBe('ok');
  });

  it('retries HTTP 429 responses and honors Retry-After', async () => {
    const success = {
      choices: [{ message: { content: 'available' }, finish_reason: 'stop' }],
      model: 'test', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    global.fetch = jest.fn()
      .mockResolvedValueOnce(new Response('busy', { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(success), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await expect(new VllmService('test').generateText({ prompt: 'retry me' })).resolves.toBe('available');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('retains model and usage while disabled reasoning capture leaves no private text in metadata', async () => {
    process.env.AI_CAPTURE_REASONING_ENABLED='false';
    global.fetch=jest.fn().mockResolvedValue({ok:true,json:async()=>({choices:[{message:{content:'visible answer',reasoning_content:'private reasoning must stay private'},finish_reason:'stop'}],model:'reported-model',usage:{prompt_tokens:8,completion_tokens:4,total_tokens:12}})});
    const ai=new VllmService('configured-model');expect(await ai.generateText({prompt:'fixture',terminalPolicy:TERMINAL_REASON_POLICIES.prose})).toBe('visible answer');
    expect(ai.getLastInferenceMetadata()).toEqual({model:'reported-model',reportedModel:'reported-model',stream:false,capturedAt:expect.any(String),usage:{promptTokens:8,completionTokens:4,totalTokens:12}});
    expect(JSON.stringify(ai.getLastInferenceMetadata())).not.toContain('private reasoning');
  });
  it('distinguishes configured fallback from a model the provider actually reported', async () => {
    process.env.AI_CAPTURE_REASONING_ENABLED='false';global.fetch=jest.fn().mockResolvedValue({ok:true,json:async()=>({choices:[{message:{content:'visible answer'},finish_reason:'stop'}]})});
    const ai=new VllmService('configured-model');await ai.generateText({prompt:'fixture'});expect(ai.getLastInferenceMetadata()).toMatchObject({model:'configured-model'});expect(ai.getLastInferenceMetadata()?.reportedModel).toBeUndefined();
  });
  it('keeps request-local model selection isolated and forwards explicit no-replay authority into transport', async () => {
    const base=new VllmService('shared-model');const router=new ModelRouter([base]);const selected=router.forRequest('generic','owned-model',{noTransportReplay:true});expect(selected).not.toBe(base);expect(selected.getModel?.()).toBe('owned-model');expect(base.getModel()).toBe('shared-model');
    global.fetch=jest.fn().mockRejectedValue(new Error('Unknown guarded effect'));await expect(selected.generateText({prompt:'owned fixture'})).rejects.toThrow('Unknown guarded effect');expect(global.fetch).toHaveBeenCalledTimes(1);expect(base.getLastInferenceMetadata()).toBeNull();
  });
  it('never retries an unknown transport effect for revision-bound terminal policies', async () => {
    global.fetch=jest.fn().mockRejectedValue(new Error('Lost provider acknowledgement'));
    await expect(new VllmService('fixture',{noTransportReplay:true}).generateText({prompt:'exact fixture',terminalPolicy:TERMINAL_REASON_POLICIES.prose})).rejects.toThrow('Lost provider acknowledgement');expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it('captures non-stream reasoning metadata when the feature flag is enabled', async () => {
    process.env.AI_CAPTURE_REASONING_ENABLED = 'true';
    // @ts-ignore
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'final answer', reasoning: 'private reasoning' } }],
        model: 'test-model',
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
      })
    });

    const ai = new VllmService('test');
    const result = await ai.generateText({ prompt: 'hello' });

    expect(result).toBe('final answer');
    expect(ai.getLastInferenceMetadata()).toEqual({
      model: 'test-model',
      reportedModel: 'test-model',
      stream: false,
      capturedAt: expect.any(String),
      reasoning: 'private reasoning',
      usage: {
        promptTokens: 11,
        completionTokens: 7,
        totalTokens: 18,
      },
    });
  });

  it('disables Qwen thinking through llama.cpp chat template kwargs by default', async () => {
    process.env.INFERENCE_BACKEND = 'llamacpp';
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:8000';
    // @ts-ignore
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        model: 'qwen3.6-35b',
      }),
    });

    const ai = new VllmService('qwen3.6-35b');
    await ai.generateText({ prompt: 'hello' });

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('disables llama.cpp thinking when the deployment uses a generic model alias', async () => {
    process.env.INFERENCE_BACKEND = 'llamacpp';
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:8000';
    // @ts-ignore
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        model: 'qwen3.6-35b',
      }),
    });

    const ai = new VllmService('vllm');
    await ai.generateChatCompletion({
      messages: [{ role: 'user', content: 'hello' }],
      thinking: 'disabled',
    });

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.model).toBe('vllm');
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('forwards task-specific sampling and bounded thinking controls', async () => {
    process.env.INFERENCE_BACKEND = 'llamacpp';
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:8000';
    // @ts-ignore
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'done' }, finish_reason: 'stop' }], model: 'qwen3.6-35b' }),
    });

    const ai = new VllmService('qwen3.6-35b');
    await ai.generateText({ prompt: 'plan', params: {
      temperature: 0.6, topP: 0.95, topK: 20, minP: 0,
      presencePenalty: 0, repeatPenalty: 1, seed: 42,
      glmThinking: true, thinkingBudgetTokens: 768,
    } });

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body).toMatchObject({
      temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0,
      presence_penalty: 0, repeat_penalty: 1, seed: 42,
      thinking_budget_tokens: 768,
      chat_template_kwargs: { enable_thinking: true },
    });
  });

  it('retries and rejects reasoning-only or empty visible output', async () => {
    process.env.INFERENCE_BACKEND = 'llamacpp';
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:8000';
    // @ts-ignore
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '', reasoning_content: 'unfinished plan' }, finish_reason: 'length' }], model: 'qwen3.6-35b' }),
    });

    const ai = new VllmService('qwen3.6-35b');
    await expect(ai.generateText({ prompt: 'answer visibly' })).rejects.toThrow('no visible content');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  it('sends strict JSON Schema response constraints with critic sampling', async () => {
    process.env.INFERENCE_BACKEND = 'llamacpp';
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:8000';
    // @ts-ignore
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"resolved":true}' }, finish_reason: 'stop' }], model: 'qwen3.6-35b' }),
    });

    const ai = new VllmService('qwen3.6-35b');
    await ai.generateChatCompletion({
      messages: [{ role: 'user', content: 'verify' }],
      responseFormat: { type: 'json_schema', json_schema: { name: 'verification', strict: true, schema: {
        type: 'object', additionalProperties: false, required: ['resolved'], properties: { resolved: { type: 'boolean' } },
      } } },
      thinking: 'disabled', temperature: 0.2, topP: 0.85, topK: 20, presencePenalty: 0,
    });

    const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(body.response_format.json_schema).toMatchObject({ name: 'verification', strict: true });
    expect(body).toMatchObject({ temperature: 0.2, top_p: 0.85, top_k: 20, presence_penalty: 0 });
  });

  it('captures streaming reasoning deltas when the feature flag is enabled', async () => {
    process.env.AI_CAPTURE_REASONING_ENABLED = 'true';
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"model":"stream-model","choices":[{"delta":{"reasoning":"plan "}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"more"}}],"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: [DONE]\n\n'
    ];
    let index = 0;

    // @ts-ignore
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (index >= chunks.length) return { done: true, value: undefined };
            const value = encoder.encode(chunks[index]);
            index += 1;
            return { done: false, value };
          }
        })
      }
    });

    const ai = new VllmService('test');
    const streamed: string[] = [];
    for await (const chunk of ai.generateStream({ prompt: 'stream me' })) {
      streamed.push(chunk);
    }

    expect(streamed.join('')).toBe('Hello world');
    expect(ai.getLastInferenceMetadata()).toEqual({
      model: 'stream-model',
      reportedModel: 'stream-model',
      stream: true,
      capturedAt: expect.any(String),
      reasoning: 'plan more',
      usage: {
        promptTokens: 3,
        completionTokens: 5,
        totalTokens: 8,
      },
    });
  });

  it('returns immediately on DONE and sanitizes reasoning tags split across framed SSE events', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Visible <thi"}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{"content":"nk>private plan"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"</think> ending"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    let reads = 0; let cancelled = false;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => ({
        read: async () => {
          reads += 1;
          if (reads <= chunks.length) return { done: false, value: encoder.encode(chunks[reads - 1]) };
          return await new Promise(() => undefined);
        },
        cancel: async () => { cancelled = true; },
      }) },
    });
    const ai = new VllmService('test');
    const output: string[] = [];
    for await (const chunk of ai.generateStream({ prompt: 'framed stream' })) output.push(chunk);
    expect(output.join('')).toBe('Visible  ending');
    expect(reads).toBe(4);
    expect(cancelled).toBe(true);
  });

  it('rejects malformed SSE JSON instead of accepting partial prose', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Partial prose"}}]}\n\n',
      'data: {malformed final json}\n\n',
    ];
    let index = 0;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => ({
        read: async () => index < chunks.length ? { done: false, value: encoder.encode(chunks[index++]) } : { done: true },
        cancel: async () => undefined,
      }) },
    });
    const ai = new VllmService('test');
    const output: string[] = [];
    await expect((async () => { for await (const chunk of ai.generateStream({ prompt: 'malformed' })) output.push(chunk); })()).rejects.toThrow('SSE protocol error');
    expect(output.join('')).toBe('');
  });

  it('rejects premature stream EOF but accepts a valid finish reason without DONE', async () => {
    const encoder = new TextEncoder();
    const response = (chunks: string[]) => {
      let index = 0;
      return {
        ok: true,
        body: { getReader: () => ({
          read: async () => index < chunks.length ? { done: false, value: encoder.encode(chunks[index++]) } : { done: true },
          cancel: async () => undefined,
        }) },
      };
    };
    global.fetch = jest.fn().mockResolvedValue(response(['data: {"choices":[{"delta":{"content":"Dropped"}}]}\n\n']));
    const dropped = new VllmService('test');
    await expect((async () => { for await (const _chunk of dropped.generateStream({ prompt: 'dropped' })) { /* consume */ } })()).rejects.toThrow('premature EOF');

    global.fetch = jest.fn().mockResolvedValue(response([
      'data: {"choices":[{"delta":{"content":"Complete"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    ]));
    const complete = new VllmService('test');
    const output: string[] = [];
    for await (const chunk of complete.generateStream({ prompt: 'terminal reason' })) output.push(chunk);
    expect(output.join('')).toBe('Complete');
  });

  it('classifies truncation and rejects terminal reasons incompatible with prose', async () => {
    const encoder = new TextEncoder();
    const response = (finishReason: string) => {
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Provisional prose"}}]}\n\n',
        `data: {"choices":[{"delta":{},"finish_reason":"${finishReason}"}]}\n\n`,
        'data: [DONE]\n\n',
      ];
      let index = 0;
      return {
        ok: true,
        body: { getReader: () => ({
          read: async () => index < chunks.length ? { done: false, value: encoder.encode(chunks[index++]) } : { done: true },
          cancel: async () => undefined,
        }) },
      };
    };

    global.fetch = jest.fn().mockResolvedValue(response('length'));
    const truncated = new VllmService('test');
    await expect((async () => {
      for await (const _chunk of truncated.generateStream({ prompt: 'prose', terminalPolicy: TERMINAL_REASON_POLICIES.prose })) { /* provisional */ }
    })()).rejects.toMatchObject({ code: 'INFERENCE_TRUNCATED', finishReason: 'length' } satisfies Partial<InferenceTerminalError>);

    global.fetch = jest.fn().mockResolvedValue(response('tool_calls'));
    const incompatible = new VllmService('test');
    await expect((async () => {
      for await (const _chunk of incompatible.generateStream({ prompt: 'prose', terminalPolicy: TERMINAL_REASON_POLICIES.prose })) { /* provisional */ }
    })()).rejects.toMatchObject({ code: 'INFERENCE_TERMINAL_INVALID', finishReason: 'tool_calls' } satisfies Partial<InferenceTerminalError>);
  });

  it.each([
    ['length', 'INFERENCE_TRUNCATED'],
    ['content_filter', 'INFERENCE_BLOCKED'],
    ['tool_calls', 'INFERENCE_TERMINAL_INVALID'],
  ] as const)('does not open the provider circuit for terminal outcome %s', async (finishReason, code) => {
    const encoder = new TextEncoder();
    let readIndex = 0;
    const frames = [
      `data: {"choices":[{"delta":{"content":"Partial"},"finish_reason":"${finishReason}"}]}\n\n`,
      'data: [DONE]\n\n',
    ];
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      body: { getReader: () => ({
        read: async () => readIndex < frames.length ? { done: false, value: encoder.encode(frames[readIndex++]) } : { done: true },
        cancel: async () => undefined,
      }) },
    }).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'healthy' }, finish_reason: 'stop' }], model: 'test' }),
    });

    const ai = new VllmService('test');
    await expect((async () => {
      for await (const _chunk of ai.generateStream({ prompt: 'terminal', terminalPolicy: TERMINAL_REASON_POLICIES.prose })) { /* provisional */ }
    })()).rejects.toMatchObject({ code });
    await expect(ai.generateText({ prompt: 'unrelated request' })).resolves.toBe('healthy');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects a streaming response without a reader without issuing a second request', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, body: null });
    const ai = new VllmService('test');
    await expect((async () => {
      for await (const _chunk of ai.generateStream({
        prompt: 'one request only',
        params: { maxTokens: 123, temperature: 0.4 },
        terminalPolicy: TERMINAL_REASON_POLICIES.prose,
      })) { /* consume */ }
    })()).rejects.toThrow('missing readable body');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body)).toMatchObject({
      stream: true,
      max_tokens: 123,
      temperature: 0.4,
    });
  });

  it('accepts fragmented CRLF DONE at EOF without losing the model finish reason', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Complete"}}]}\r\n\r\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\n',
      'data: [DO',
      'NE]',
    ];
    let index = 0;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      body: { getReader: () => ({
        read: async () => index < chunks.length ? { done: false, value: encoder.encode(chunks[index++]) } : { done: true },
        cancel: async () => undefined,
      }) },
    });

    const ai = new VllmService('test');
    const output: string[] = [];
    for await (const chunk of ai.generateStream({ prompt: 'EOF', terminalPolicy: TERMINAL_REASON_POLICIES.prose })) output.push(chunk);
    expect(output.join('')).toBe('Complete');
  });
});
