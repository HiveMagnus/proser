import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const signIn = vi.fn();
vi.mock('next-auth/react', () => ({ signIn: (...args: unknown[]) => signIn(...args) }));

import { SignInForm } from '@/app/auth/signin/sign-in-form';

describe('SignInForm two-step verification', () => {
  beforeEach(() => signIn.mockReset());

  it('asks for an authentication code and resubmits it with the password', async () => {
    signIn
      .mockResolvedValueOnce({ error: 'CredentialsSignin', code: 'mfa_required', ok: false })
      .mockResolvedValueOnce({ error: 'CredentialsSignin', code: 'mfa_invalid', ok: false });
    const user = userEvent.setup();
    render(<SignInForm callbackUrl="/" serverError={null} />);

    await user.type(screen.getByLabelText('Username'), 'writer');
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const code = await screen.findByLabelText('Authentication code');
    expect(screen.queryByText('Invalid username or password')).not.toBeInTheDocument();
    await user.type(code, '123456');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(signIn).toHaveBeenCalledTimes(2));
    expect(signIn.mock.calls[1]?.[1]).toMatchObject({
      username: 'writer',
      password: 'pw',
      code: '123456',
    });
    expect(
      await screen.findByText('That authentication code was not accepted. Try again.'),
    ).toBeInTheDocument();
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
    // The password fallback is still offered.
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('offers only Oathweave once the password relay is off', () => {
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

  it('shows no Oathweave button when OIDC is not configured', () => {
    render(<SignInForm callbackUrl="/" serverError={null} />);
    expect(screen.queryByRole('button', { name: 'Sign in with Oathweave' })).toBeNull();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });
});
