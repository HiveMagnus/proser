import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsPage from '@/app/settings/page';

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    data: {
      user: {
        email: 'fixture-author@example.com',
      },
    },
  }),
}));

type MockResponse = {
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
};

function createJsonResponse(data: unknown, ok = true, status = 200): MockResponse {
  return {
    ok,
    status,
    json: async () => data,
  };
}

describe('SettingsPage', () => {
  const fetchMock =
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<MockResponse>>();

  beforeEach(() => {
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url === '/api/settings') {
        if (method === 'PUT') {
          const body = JSON.parse(String(init?.body ?? '{}')) as {
            profile?: { displayName?: string };
            writing?: { defaultGenre?: string; writingStyle?: string; targetAudience?: string };
          };
          return createJsonResponse({
            data: {
              profile: { displayName: body.profile?.displayName ?? '' },
              writing: {
                defaultGenre: body.writing?.defaultGenre ?? '',
                writingStyle: body.writing?.writingStyle ?? '',
                targetAudience: body.writing?.targetAudience ?? '',
              },
            },
          });
        }
        return createJsonResponse({
          data: {
            profile: { displayName: '' },
            writing: { defaultGenre: '', writingStyle: '', targetAudience: '' },
          },
        });
      }

      if (url === '/api/models/settings' && method === 'GET') {
        return createJsonResponse({
          data: {
            host: 'http://127.0.0.1:8000',
            model: 'qwen3.6-35b',
          },
        });
      }

      if (url === '/api/models') {
        return createJsonResponse({
          data: [
            {
              id: 'qwen3.6-35b',
              name: 'qwen3.6-35b',
            },
          ],
        });
      }

      if (url === '/api/settings/about') {
        return createJsonResponse({
          data: { version: '1.0.8', revision: '0123456789abcdef0123456789abcdef01234567' },
        });
      }

      if (url === '/api/models/status') {
        return createJsonResponse({ data: { connected: true } });
      }

      return createJsonResponse({}, false, 404);
    });

    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the release version and revision the installation runs', async () => {
    render(<SettingsPage />);
    expect(await screen.findByTestId('proser-release')).toHaveTextContent(
      'Proser 1.0.8 · revision 0123456789ab',
    );
  });

  it('shows runtime inference settings as read-only', async () => {
    render(<SettingsPage />);
    await userEvent.setup().click(screen.getByRole('tab', { name: /AI Config/i }));

    expect(await screen.findByDisplayValue('http://127.0.0.1:8000')).toBeDisabled();
    expect(screen.getByDisplayValue('qwen3.6-35b')).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: /Save Inference Settings/i }),
    ).not.toBeInTheDocument();
  });

  it('offers no per-user cloud provider key fields', async () => {
    render(<SettingsPage />);
    await userEvent.setup().click(screen.getByRole('tab', { name: /AI Config/i }));

    await screen.findByDisplayValue('http://127.0.0.1:8000');
    expect(screen.queryByText(/Cloud API Keys/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/API Key/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save Keys/i })).not.toBeInTheDocument();
  });

  it('tests only the operator-configured inference connection', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);

    await user.click(screen.getByRole('tab', { name: /AI Config/i }));

    await user.click(screen.getByRole('button', { name: /Test Connection/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/models/status', expect.any(Object));
    });

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => url === '/api/models')).toBe(true);
    });
  });

  it('saves profile settings through /api/settings', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);

    const nameInput = await screen.findByPlaceholderText('Your name');
    await user.clear(nameInput);
    await user.type(nameInput, 'Swarm Lord');
    await user.click(screen.getByRole('button', { name: /Save Profile/i }));

    await waitFor(() => {
      const saveCall = fetchMock.mock.calls.find(
        ([url, init]) => url === '/api/settings' && init?.method === 'PUT',
      );
      expect(saveCall).toBeTruthy();
      const body = JSON.parse(String(saveCall?.[1]?.body ?? '{}')) as {
        profile?: { displayName?: string };
      };
      expect(body.profile?.displayName).toBe('Swarm Lord');
    });
  });

  it('saves writing preferences through /api/settings', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);

    await user.click(screen.getByRole('tab', { name: /Writing/i }));
    await user.type(
      screen.getByPlaceholderText('Describe your preferred writing style...'),
      'Lush and ominous',
    );
    await user.click(screen.getByRole('button', { name: /Save Preferences/i }));

    await waitFor(() => {
      const putCalls = fetchMock.mock.calls.filter(
        ([url, init]) => url === '/api/settings' && init?.method === 'PUT',
      );
      const body = JSON.parse(String(putCalls.at(-1)?.[1]?.body ?? '{}')) as {
        writing?: { defaultGenre?: string; writingStyle?: string; targetAudience?: string };
      };
      expect(body.writing).toEqual({
        defaultGenre: '',
        writingStyle: 'Lush and ominous',
        targetAudience: '',
      });
    });
  });
});
