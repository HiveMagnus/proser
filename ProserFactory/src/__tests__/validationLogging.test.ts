import { z } from 'zod';

import { zodIssueLog } from '@/api/middleware/zodValidation';

describe('validation logging', () => {
  it('records only issue paths and codes, never custom messages or supplied values', () => {
    const supplied = 'private-user-value';
    const schema = z.object({
      title: z.string().superRefine((value, context) => {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `rejected ${value}`,
        });
      }),
    });
    const result = schema.safeParse({ title: supplied });
    expect(result.success).toBe(false);
    if (result.success) return;
    const logged = zodIssueLog(result.error);
    expect(logged).toEqual([{ path: 'title', code: 'custom' }]);
    expect(JSON.stringify(logged)).not.toContain(supplied);
    expect(JSON.stringify(logged)).not.toContain('rejected');
  });
});
