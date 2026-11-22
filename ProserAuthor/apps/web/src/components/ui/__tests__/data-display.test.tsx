import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { EmptyState, StatCard } from '../data-display';

describe('EmptyState', () => {
  it('renders title', () => {
    render(<EmptyState title="Nothing here" />);
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(<EmptyState title="Empty" description="Add something" />);
    expect(screen.getByText('Add something')).toBeInTheDocument();
  });

  it('renders action when provided', () => {
    render(<EmptyState title="Empty" action={<button>Create</button>} />);
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });

  it('renders icon when provided', () => {
    render(<EmptyState title="Empty" icon={<span data-testid="icon">★</span>} />);
    expect(screen.getByTestId('icon')).toBeInTheDocument();
  });
});

describe('StatCard', () => {
  it('renders label and value', () => {
    render(<StatCard label="Words" value={12345} />);
    expect(screen.getByText('Words')).toBeInTheDocument();
    expect(screen.getByText('12345')).toBeInTheDocument();
  });

  it('renders sublabel when provided', () => {
    render(<StatCard label="Score" value="95%" sublabel="Above average" />);
    expect(screen.getByText('Above average')).toBeInTheDocument();
  });

  it('renders trend indicator', () => {
    const { container } = render(<StatCard label="Growth" value="10" trend="up" />);
    expect(container.textContent).toContain('↑');
  });

  it('renders downward trend', () => {
    const { container } = render(<StatCard label="Bugs" value="3" trend="down" />);
    expect(container.textContent).toContain('↓');
  });
});
