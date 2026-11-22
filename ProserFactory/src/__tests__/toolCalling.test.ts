import { VllmService, type AIToolCall } from '../lib/ai/vllm';

describe('GLM tool calling support', () => {
  const realFetch = global.fetch as any;
  const realOllamaBaseUrl = process.env.OLLAMA_BASE_URL;
  const realOllamaHost = process.env.OLLAMA_HOST;
  const realInferenceBackend = process.env.INFERENCE_BACKEND;

  afterEach(() => {
    // @ts-ignore restore
    global.fetch = realFetch;
    if (typeof realOllamaBaseUrl === 'undefined') {
      delete process.env.OLLAMA_BASE_URL;
    } else {
      process.env.OLLAMA_BASE_URL = realOllamaBaseUrl;
    }
    if (typeof realOllamaHost === 'undefined') {
      delete process.env.OLLAMA_HOST;
    } else {
      process.env.OLLAMA_HOST = realOllamaHost;
    }
    if (typeof realInferenceBackend === 'undefined') {
      delete process.env.INFERENCE_BACKEND;
    } else {
      process.env.INFERENCE_BACKEND = realInferenceBackend;
    }
  });

  it('injects /think for namespaced GLM models on Ollama-backed chat completions', async () => {
    process.env.INFERENCE_BACKEND = 'ollama';
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
    process.env.OLLAMA_HOST = 'http://127.0.0.1:11434';
    // @ts-ignore
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        model: 'huihui_ai/glm-4.7-flash-abliterated:q8_0',
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }),
    });

    const ai = new VllmService('huihui_ai/glm-4.7-flash-abliterated:q8_0');
    await ai.generateChatCompletion({
      messages: [{ role: 'user', content: 'Check the scene continuity.' }],
      thinking: 'enabled',
    });

    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages[0]?.role).toBe('system');
    expect(body.messages[0]?.content).toContain('/think');
  });

  it('runs a complete tool loop and feeds tool results back to the model', async () => {
    process.env.INFERENCE_BACKEND = 'ollama';
    process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
    process.env.OLLAMA_HOST = 'http://127.0.0.1:11434';
    // @ts-ignore
    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'deterministic_check',
                  arguments: { sceneId: 42, rule: 'timeline' },
                },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          model: 'huihui_ai/glm-4.7-flash-abliterated:q8_0',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: 'Timeline is consistent after checking the deterministic validator.',
            },
            finish_reason: 'stop',
          }],
          model: 'huihui_ai/glm-4.7-flash-abliterated:q8_0',
          usage: { prompt_tokens: 18, completion_tokens: 7, total_tokens: 25 },
        }),
      });

    const executed: AIToolCall[] = [];
    const ai = new VllmService('huihui_ai/glm-4.7-flash-abliterated:q8_0');

    const result = await ai.runToolLoop({
      messages: [{ role: 'user', content: 'Check whether the timeline is consistent.' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'deterministic_check',
            description: 'Run a deterministic validation',
            parameters: {
              type: 'object',
              properties: {
                sceneId: { type: 'number' },
                rule: { type: 'string' },
              },
              required: ['sceneId', 'rule'],
            },
          },
        },
      ],
      toolChoice: 'auto',
      thinking: 'enabled',
      executeTool: async (toolCall) => {
        executed.push(toolCall);
        return { ok: true, rule: 'timeline', verdict: 'pass' };
      },
    });

    expect(executed).toHaveLength(1);
    expect(executed[0]?.function.name).toBe('deterministic_check');
    expect(result.message.content).toContain('Timeline is consistent');

    const [, secondInit] = (global.fetch as jest.Mock).mock.calls[1] as [string, RequestInit];
    const secondBody = JSON.parse(String(secondInit.body)) as {
      messages: Array<{ role: string; tool_call_id?: string; content?: string }>;
    };
    expect(secondBody.messages.some((message) => message.role === 'tool' && message.tool_call_id === 'call_1')).toBe(true);
  });
});
