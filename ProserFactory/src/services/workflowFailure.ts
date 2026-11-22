import { AIServiceError, DatabaseError, ValidationError } from '@/lib/errors';

export type WorkflowFailureClass = 'transient' | 'infrastructure' | 'validation' | 'content';

/** Classify durable workflow failures before deciding whether unattended recovery is safe. */
export function classifyWorkflowFailure(error: unknown): WorkflowFailureClass {
  const value = error instanceof Error ? error : new Error(String(error));
  const message = `${value.name}: ${value.message}`.toLowerCase();

  if (value instanceof ValidationError || /\b(?:zod|validation|invalid structured output|schema|unsupported workflow|requires? (?:a |the )?|not found|non-retryable http 4\d\d)\b/.test(message)) {
    return 'validation';
  }
  if (/\b(?:manuscript|canon|content|prose|placeholder|truncat(?:ed|ion)|word count|release gate|evidence|revision)\b/.test(message)) {
    return 'content';
  }
  if (
    value instanceof AIServiceError || value instanceof DatabaseError || value.name === 'AbortError'
    || /\b(?:econn|enotfound|socket|network|timed? ?out|timeout|http 5\d\d|http 429|circuit|deadlock|serialization|worker|redis|bullmq|premature eof|sse protocol)\b/.test(message)
  ) {
    return 'infrastructure';
  }
  return 'transient';
}
