export type InferenceTerminalReason = 'stop' | 'length' | 'tool_calls' | 'content_filter';

export interface InferenceTerminalPolicy {
  context: 'plain_text' | 'prose' | 'structured' | 'agent_loop';
  allowedReasons: readonly InferenceTerminalReason[];
}

export const TERMINAL_REASON_POLICIES = {
  plainText: { context: 'plain_text', allowedReasons: ['stop'] },
  prose: { context: 'prose', allowedReasons: ['stop'] },
  structured: { context: 'structured', allowedReasons: ['stop'] },
  agentLoop: { context: 'agent_loop', allowedReasons: ['stop', 'tool_calls'] },
} as const satisfies Record<string, InferenceTerminalPolicy>;

export class InferenceTerminalError extends Error {
  constructor(
    public readonly code: 'INFERENCE_TRUNCATED' | 'INFERENCE_BLOCKED' | 'INFERENCE_TERMINAL_INVALID',
    public readonly finishReason: string,
    public readonly context: InferenceTerminalPolicy['context'],
    public readonly partialOutput = '',
  ) {
    super(code === 'INFERENCE_TRUNCATED'
      ? 'Inference output was truncated before completion'
      : code === 'INFERENCE_BLOCKED'
        ? 'Inference output requires content review'
        : 'Inference ended with an incompatible terminal reason');
    this.name = 'InferenceTerminalError';
  }
}

export function enforceTerminalReason(
  reason: string | null | undefined,
  policy: InferenceTerminalPolicy | undefined,
  partialOutput = '',
): void {
  if (!policy) return;
  if (reason === 'length') throw new InferenceTerminalError('INFERENCE_TRUNCATED', reason, policy.context, partialOutput);
  if (reason === 'content_filter') throw new InferenceTerminalError('INFERENCE_BLOCKED', reason, policy.context, partialOutput);
  if (!policy.allowedReasons.includes(reason as InferenceTerminalReason)) {
    throw new InferenceTerminalError('INFERENCE_TERMINAL_INVALID', reason ?? 'missing', policy.context, partialOutput);
  }
}
