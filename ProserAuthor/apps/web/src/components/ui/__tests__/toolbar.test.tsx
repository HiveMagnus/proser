import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Toolbar, ToolbarGroup, ToolbarButton, ToolbarSeparator } from '../toolbar';

describe('Toolbar', () => {
  it('renders with role="toolbar"', () => {
    render(
      <Toolbar>
        <ToolbarButton>Bold</ToolbarButton>
      </Toolbar>,
    );
    expect(screen.getByRole('toolbar')).toBeInTheDocument();
  });

  it('renders buttons inside groups', () => {
    render(
      <Toolbar>
        <ToolbarGroup>
          <ToolbarButton>Bold</ToolbarButton>
          <ToolbarButton>Italic</ToolbarButton>
        </ToolbarGroup>
      </Toolbar>,
    );
    expect(screen.getByText('Bold')).toBeInTheDocument();
    expect(screen.getByText('Italic')).toBeInTheDocument();
  });

  it('renders a separator between groups', () => {
    const { container } = render(
      <Toolbar>
        <ToolbarGroup>
          <ToolbarButton>A</ToolbarButton>
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup>
          <ToolbarButton>B</ToolbarButton>
        </ToolbarGroup>
      </Toolbar>,
    );
    // ToolbarSeparator renders a vertical divider element
    const sep = container.querySelector('[data-orientation="vertical"]');
    expect(sep).toBeInTheDocument();
  });

  it('applies active state to ToolbarButton', () => {
    render(
      <Toolbar>
        <ToolbarButton active>Active</ToolbarButton>
      </Toolbar>,
    );
    const btn = screen.getByRole('button', { name: 'Active' });
    expect(btn.className).toContain('bg-accent');
  });
});
