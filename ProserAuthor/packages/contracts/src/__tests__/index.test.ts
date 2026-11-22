import { describe, it, expect } from 'vitest';
import { z } from '../index.js';

describe('@cheftaco/proser-contracts', () => {
  it('re-exports zod', () => {
    expect(z).toBeDefined();
    const schema = z.object({ name: z.string() });
    expect(schema.parse({ name: 'Proser' })).toEqual({ name: 'Proser' });
  });
});
