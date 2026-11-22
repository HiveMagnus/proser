import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Input, Textarea } from '../input';

describe('Input', () => {
  it('renders an input element', () => {
    render(<Input placeholder="Enter text" />);
    expect(screen.getByPlaceholderText('Enter text')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    render(<Input className="custom" placeholder="test" />);
    expect(screen.getByPlaceholderText('test')).toHaveClass('custom');
  });

  it('forwards the type prop', () => {
    render(<Input type="password" placeholder="pw" />);
    expect(screen.getByPlaceholderText('pw')).toHaveAttribute('type', 'password');
  });

  it('supports disabled state', () => {
    render(<Input disabled placeholder="disabled" />);
    expect(screen.getByPlaceholderText('disabled')).toBeDisabled();
  });
});

describe('Textarea', () => {
  it('renders a textarea element', () => {
    render(<Textarea placeholder="Type here" />);
    expect(screen.getByPlaceholderText('Type here')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Type here').tagName).toBe('TEXTAREA');
  });

  it('applies custom rows', () => {
    render(<Textarea rows={5} placeholder="multi" />);
    expect(screen.getByPlaceholderText('multi')).toHaveAttribute('rows', '5');
  });
});
