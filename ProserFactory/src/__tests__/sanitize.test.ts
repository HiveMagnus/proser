import { stripThinkingBlocks } from '../lib/ai/sanitize';

describe('stripThinkingBlocks', () => {
  it('removes <think> blocks', () => {
    const input = 'Answer start.\n<think>secret reasoning</think>\nFinal answer.';
    expect(stripThinkingBlocks(input)).toBe('Answer start.\nFinal answer.');
  });

  it('removes fenced code blocks labelled think', () => {
    const input = 'A\n```think\ninternal\n```\nB';
    expect(stripThinkingBlocks(input)).toBe('A\nB');
  });

  it('removes BBCode [think] blocks', () => {
    const input = 'A [think] internal [/think] B';
    expect(stripThinkingBlocks(input)).toBe('A  B'.trim());
  });

  it('removes single-line Thought: prefixes but keeps rest', () => {
    const input = 'Thought: do not show\nVisible line';
    expect(stripThinkingBlocks(input)).toBe('Visible line');
  });

  it('is idempotent and preserves normal content', () => {
    const input = 'Just normal content without secrets.';
    expect(stripThinkingBlocks(stripThinkingBlocks(input))).toBe(input);
  });
});
