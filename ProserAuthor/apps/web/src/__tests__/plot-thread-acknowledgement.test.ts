import { describe, expect, it } from 'vitest';
import { verifyPlotThreadAcknowledgement } from '@/lib/plot-thread-api';
import type { PlotThreadIntent } from '@/lib/plot-thread-journal';
const intent: PlotThreadIntent = {
  userId: 'owner',
  bookId: '7',
  operationId: 'original',
  kind: 'mutation',
  method: 'POST',
  path: '/api/books/7/plot-threads/4/evidence',
  recoveryPath: '/receipt',
  body: { operationId: 'original', expectedVersion: 2 },
};
describe('Plot Threads exact acknowledgments', () => {
  it('accepts only the original operation and owned thread receipt', () => {
    expect(() =>
      verifyPlotThreadAcknowledgement(intent, { operationId: 'original', threadId: 4, version: 3 }),
    ).not.toThrow();
    expect(() =>
      verifyPlotThreadAcknowledgement(intent, { operationId: 'other', threadId: 4, version: 3 }),
    ).toThrow('another operation');
    expect(() =>
      verifyPlotThreadAcknowledgement(intent, {
        operationId: 'original',
        threadId: 99,
        version: 3,
      }),
    ).toThrow('another source');
  });
  it('requires the exact proposal/application identity during recovery', () => {
    const apply = { ...intent, kind: 'apply' as const };
    expect(() =>
      verifyPlotThreadAcknowledgement(apply, { application: { operationId: 'original' } }, true),
    ).not.toThrow();
    expect(() =>
      verifyPlotThreadAcknowledgement(
        apply,
        { application: { operationId: 'another-application' } },
        true,
      ),
    ).toThrow();
    expect(() =>
      verifyPlotThreadAcknowledgement(
        { ...intent, kind: 'proposal' },
        { id: 'original', status: 'applied' },
        true,
      ),
    ).not.toThrow();
    expect(() =>
      verifyPlotThreadAcknowledgement(
        { ...intent, kind: 'review' },
        { id: 'original', status: 'applied' },
        true,
      ),
    ).toThrow('Invalid operation status');
    expect(() =>
      verifyPlotThreadAcknowledgement(
        { ...intent, kind: 'review' },
        { id: 'original', status: 'unknown' },
      ),
    ).not.toThrow();
    expect(() =>
      verifyPlotThreadAcknowledgement({ ...intent, kind: 'review' }, { id: 'foreign-review' }),
    ).toThrow();
  });
});
