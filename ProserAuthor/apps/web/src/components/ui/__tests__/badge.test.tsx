import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Badge } from '../badge';

describe('Badge', () => {
  it('renders text content', () => {
    render(<Badge>Label</Badge>);
    expect(screen.getByText('Label')).toBeInTheDocument();
  });

  it('applies default variant', () => {
    const { container } = render(<Badge>Default</Badge>);
    expect(container.firstChild).toHaveClass('bg-surface-raised');
  });

  it('applies accent variant', () => {
    const { container } = render(<Badge variant="accent">Accent</Badge>);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain('accent');
  });

  it('applies success variant', () => {
    const { container } = render(<Badge variant="success">Done</Badge>);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain('success');
  });

  it('applies danger variant', () => {
    const { container } = render(<Badge variant="danger">Error</Badge>);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain('danger');
  });

  it('merges custom class names', () => {
    const { container } = render(<Badge className="custom-class">Custom</Badge>);
    expect(container.firstChild).toHaveClass('custom-class');
  });
});
