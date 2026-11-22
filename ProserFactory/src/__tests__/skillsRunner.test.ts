import { registerSkill, runSkills } from '@/lib/skills/runner';

jest.mock('@/core/config', () => ({
  CONFIG: {
    SKILLS_RUNTIME_ENABLED: true,
    SKILLS_MODE: 'async',
    SKILLS_CONFIDENCE_THRESHOLD: 0.6,
  },
}));

jest.mock('@/lib/database', () => ({
  databaseService: {
    client: { skillRun: { create: jest.fn() } },
  },
}));

describe('skill deadline cleanup', () => {
  afterEach(() => jest.useRealTimers());

  test.each(['completed', 'error'] as const)('clears the deadline when a skill settles as %s', async (status) => {
    jest.useFakeTimers();
    const name = 'deadline-fixture';
    registerSkill({
      name,
      version: '1.0.0',
      description: 'Settles before its deadline',
      analyze: async () => {
        if (status === 'error') throw new Error('Skill fixture failed');
        return { skillName: name, version: '1.0.0', status, findings: [], latencyMs: 0 };
      },
    });

    const result = await runSkills({ bookId: 1, prose: 'A synthetic draft.' }, { skillNames: [name] });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe(status);
    expect(jest.getTimerCount()).toBe(0);
  });
});
