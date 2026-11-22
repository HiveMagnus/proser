import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Skeleton, Spinner } from '../loading';

describe('Skeleton', () => {
  it('renders a div with shimmer class', () => {
    const { container } = render(<Skeleton className="h-4 w-32" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain('shimmer');
  });

  it('applies custom className', () => {
    const { container } = render(<Skeleton className="h-8" />);
    expect(container.firstChild).toHaveClass('h-8');
  });
});

describe('Spinner', () => {
  it('renders an SVG element', () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });

  it('applies custom className', () => {
    const { container } = render(<Spinner className="size-8" />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveClass('size-8');
  });
});
