import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const signIn = vi.fn();
vi.mock('next-auth/react', () => ({ signIn: (...args: unknown[]) => signIn(...args) }));

import { SignInForm } from '@/app/auth/signin/sign-in-form';

describe('SignInForm local accounts', () => {
  beforeEach(() => signIn.mockReset());

  it('submits a local account password and shows a refusal', async () => {
    signIn.mockResolvedValueOnce({ error: 'CredentialsSignin', ok: false });
    const user = userEvent.setup();
    render(<SignInForm callbackUrl="/" serverError={null} />);

    await user.type(screen.getByLabelText('Username'), 'author');
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
    expect(signIn.mock.calls[0]?.[0]).toBe('iam');
    expect(signIn.mock.calls[0]?.[1]).toEqual({
      username: 'author',
      password: 'pw',
      callbackUrl: '/',
      redirect: false,
    });
    expect(await screen.findByText('Invalid username or password')).toBeInTheDocument();
    // No second-factor step: that belonged to the removed Oathweave password relay.
    expect(screen.queryByLabelText('Authentication code')).toBeNull();
  });
});

describe('SignInForm with Oathweave OIDC', () => {
  beforeEach(() => signIn.mockReset());

  it('starts the Oathweave redirect with a portal-compatible random state', async () => {
    signIn.mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <SignInForm
        callbackUrl="/books"
        serverError={null}
        methods={{ oathweave: true, password: true }}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Sign in with Oathweave' }));
    expect(signIn).toHaveBeenCalledWith(
      'oathweave',
      { redirectTo: '/books' },
      { state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) },
    );
    // A local account, when enabled, is still offered next to Oathweave.
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('offers only Oathweave on an Oathweave installation', () => {
    render(
      <SignInForm
        callbackUrl="/"
        serverError={null}
        methods={{ oathweave: true, password: false }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Sign in with Oathweave' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('explains a refused Oathweave sign-in', () => {
    render(
      <SignInForm
        callbackUrl="/"
        serverError="AccessDenied"
        methods={{ oathweave: true, password: false }}
      />,
    );
    expect(
      screen.getByText('Oathweave did not confirm this sign-in. Try again.'),
    ).toBeInTheDocument();
  });

  it('explains that no sign-in is configured', () => {
    render(
      <SignInForm
        callbackUrl="/"
        serverError={null}
        methods={{ oathweave: false, password: false }}
      />,
    );
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.getByText(/Sign-in is not configured/)).toBeInTheDocument();
  });

  it('shows no Oathweave button when OIDC is not configured', () => {
    render(<SignInForm callbackUrl="/" serverError={null} />);
    expect(screen.queryByRole('button', { name: 'Sign in with Oathweave' })).toBeNull();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });
});
