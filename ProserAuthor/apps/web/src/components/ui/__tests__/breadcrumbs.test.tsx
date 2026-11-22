import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Breadcrumbs, BreadcrumbItem } from '../breadcrumbs';

// Mock next/link — renders as a plain anchor
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { vi } from 'vitest';

describe('Breadcrumbs', () => {
  it('renders a <nav> with aria-label', () => {
    render(
      <Breadcrumbs>
        <BreadcrumbItem href="/">Home</BreadcrumbItem>
        <BreadcrumbItem>Current</BreadcrumbItem>
      </Breadcrumbs>,
    );
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
  });

  it('renders items as links when href is provided', () => {
    render(
      <Breadcrumbs>
        <BreadcrumbItem href="/foo">Foo</BreadcrumbItem>
        <BreadcrumbItem>Bar</BreadcrumbItem>
      </Breadcrumbs>,
    );
    const link = screen.getByRole('link', { name: 'Foo' });
    expect(link).toHaveAttribute('href', '/foo');
  });

  it('renders the last item without a link', () => {
    render(
      <Breadcrumbs>
        <BreadcrumbItem href="/">Home</BreadcrumbItem>
        <BreadcrumbItem>Current</BreadcrumbItem>
      </Breadcrumbs>,
    );
    expect(screen.queryByRole('link', { name: 'Current' })).toBeNull();
    expect(screen.getByText('Current')).toBeInTheDocument();
  });
});
