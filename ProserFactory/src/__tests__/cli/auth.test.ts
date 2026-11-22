/// <reference types="jest" />

import { resolveCliUser } from '../../cli/auth';

describe('resolveCliUser', () => {
  it('returns override ID when provided without upserting', async () => {
    const db: any = {
      user: {
        upsert: jest.fn(),
      },
    };

    const result = await resolveCliUser(db, 42);

    expect(result).toEqual({ id: 42 });
    expect(db.user.upsert).not.toHaveBeenCalled();
  });

  it('upserts default CLI user when no override is provided', async () => {
    const db: any = {
      user: {
        upsert: jest.fn().mockResolvedValue({ id: 7 }),
      },
    };

    const result = await resolveCliUser(db);

    expect(db.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { githubId: 'cli-local-user' },
      }),
    );
    expect(result).toEqual({ id: 7 });
  });
});
