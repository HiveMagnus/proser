import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  AsyncBoundary,
  ErrorPanel,
  EmptyState,
  LoadingSkeleton,
  StaleBanner,
} from '@/components/ui/async-boundary';

describe('LoadingSkeleton', () => {
  it('renders card variant', () => {
    const { container } = render(<LoadingSkeleton variant="card" />);
    expect(container.querySelectorAll('[class*="animate-pulse"]').length).toBeGreaterThan(0);
  });

  it('renders list variant', () => {
    const { container } = render(<LoadingSkeleton variant="list" />);
    expect(container.querySelectorAll('[class*="animate-pulse"]').length).toBeGreaterThan(0);
  });
});

describe('ErrorPanel', () => {
  it('renders error message string', () => {
    render(<ErrorPanel error="Something went wrong" />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('renders Error object message', () => {
    render(<ErrorPanel error={new Error('Network fail')} />);
    expect(screen.getByText('Network fail')).toBeInTheDocument();
  });

  it('shows retry button when onRetry provided', () => {
    render(<ErrorPanel error="fail" onRetry={() => {}} />);
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });
});

describe('EmptyState', () => {
  it('renders title and description', () => {
    render(<EmptyState title="Nothing here" description="Try creating something" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    expect(screen.getByText('Try creating something')).toBeInTheDocument();
  });
});

describe('StaleBanner', () => {
  it('renders stale message', () => {
    render(<StaleBanner lastSuccessful="2025-01-01T00:00:00Z" onRefresh={() => {}} />);
    expect(screen.getByText(/data may be outdated/i)).toBeInTheDocument();
  });
});

describe('AsyncBoundary', () => {
  it('shows loading when isLoading=true', () => {
    render(
      <AsyncBoundary isLoading={true}>
        <p>Content</p>
      </AsyncBoundary>,
    );
    expect(screen.queryByText('Content')).not.toBeInTheDocument();
  });

  it('shows error when error is set', () => {
    render(
      <AsyncBoundary isLoading={false} error="Boom">
        <p>Content</p>
      </AsyncBoundary>,
    );
    expect(screen.getByText('Boom')).toBeInTheDocument();
    expect(screen.queryByText('Content')).not.toBeInTheDocument();
  });

  it('shows empty state when isEmpty=true and not loading', () => {
    render(
      <AsyncBoundary isLoading={false} isEmpty={true} emptyTitle="No items">
        <p>Content</p>
      </AsyncBoundary>,
    );
    expect(screen.getByText('No items')).toBeInTheDocument();
  });

  it('renders children when loaded with data', () => {
    render(
      <AsyncBoundary isLoading={false}>
        <p>Content</p>
      </AsyncBoundary>,
    );
    expect(screen.getByText('Content')).toBeInTheDocument();
  });
});
