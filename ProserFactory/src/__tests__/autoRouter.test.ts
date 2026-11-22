let autoActivateAdapter: (genre?: string | null) => Promise<string | null>;
let mockGetActive: jest.Mock;

beforeEach(() => {
  jest.resetModules();

  mockGetActive = jest.fn().mockReturnValue(null);

  jest.doMock('../lib/ai/vllm', () => ({
    vllmService: {
      getActiveAdapterName: mockGetActive,
    },
  }));

  jest.doMock('../lib/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn() },
  }));

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../lib/ai/autoRouter');
  autoActivateAdapter = mod.autoActivateAdapter;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('autoActivateAdapter', () => {
  it('returns null when no local adapter is active', async () => {
    const result = await autoActivateAdapter('fantasy');
    expect(result).toBeNull();
  });

  it('returns the active adapter without mutating vLLM state', async () => {
    mockGetActive.mockReturnValue('adapter-x');
    const result = await autoActivateAdapter('fantasy');
    expect(result).toBe('adapter-x');
    expect(mockGetActive).toHaveBeenCalledTimes(1);
  });

  it('ignores the genre input in standalone mode', async () => {
    mockGetActive.mockReturnValue('adapter-x');
    await autoActivateAdapter(null);
    expect(mockGetActive).toHaveBeenCalledTimes(1);
  });
});
