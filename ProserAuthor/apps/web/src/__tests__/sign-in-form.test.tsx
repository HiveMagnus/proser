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
