import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentNavigationGuard } from '@/components/editor/document-navigation-guard';
const navigate = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => navigate }));
beforeEach(() => {
  vi.clearAllMocks();
});
describe('unacknowledged link navigation', () => {
  it('blocks same-tab route navigation until the document is durably acknowledged', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <>
        <DocumentNavigationGuard dirty />
        <a href="/bible?bookId=1">Book context</a>
      </>,
    );
    expect(fireEvent.click(screen.getByRole('link'))).toBe(false);
    expect(screen.getByRole('alert')).toHaveTextContent('unacknowledged work');
    expect(screen.getByRole('button', { name: 'Continue after saving' })).toBeDisabled();
    expect(navigate.push).not.toHaveBeenCalled();
    rerender(
      <>
        <DocumentNavigationGuard dirty={false} />
        <a href="/bible?bookId=1">Book context</a>
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Continue after saving' }));
    expect(navigate.push).toHaveBeenCalledWith('/bible?bookId=1');
  });
  it('keeps editing without navigation and leaves new-tab/download clicks available', async () => {
    const user = userEvent.setup();
    render(
      <>
        <DocumentNavigationGuard dirty />
        <a href="/plot">Plot</a>
        <a href="/bible" target="_blank">
          Open context tab
        </a>
        <a href="/artifact" download>
          Download
        </a>
      </>,
    );
    fireEvent.click(screen.getByText('Plot'));
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(navigate.push).not.toHaveBeenCalled();
    expect(fireEvent.click(screen.getByText('Open context tab'))).toBe(true);
    expect(fireEvent.click(screen.getByText('Download'))).toBe(true);
    expect(fireEvent.click(screen.getByText('Plot'), { ctrlKey: true })).toBe(true);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
