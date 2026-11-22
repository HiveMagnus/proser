import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  FadeIn,
  PageTransition,
  AnimatedNumber,
  ProgressRing,
} from '@/components/motion/primitives';
import { MotionProvider } from '@/contexts/motion-context';

function WithProviders({ children }: { children: React.ReactNode }) {
  return <MotionProvider>{children}</MotionProvider>;
}

describe('FadeIn', () => {
  it('renders children', () => {
    render(
      <WithProviders>
        <FadeIn>
          <p>Hello</p>
        </FadeIn>
      </WithProviders>,
    );
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });
});

describe('PageTransition', () => {
  it('renders children with default transitionKey', () => {
    render(
      <WithProviders>
        <PageTransition>
          <p>Page Content</p>
        </PageTransition>
      </WithProviders>,
    );
    expect(screen.getByText('Page Content')).toBeInTheDocument();
  });

  it('renders children with explicit transitionKey', () => {
    render(
      <WithProviders>
        <PageTransition transitionKey="test">
          <p>Keyed</p>
        </PageTransition>
      </WithProviders>,
    );
    expect(screen.getByText('Keyed')).toBeInTheDocument();
  });
});

describe('AnimatedNumber', () => {
  it('renders the value', () => {
    render(
      <WithProviders>
        <AnimatedNumber value={42} />
      </WithProviders>,
    );
    expect(screen.getByText('42')).toBeInTheDocument();
  });

  it('applies format function', () => {
    render(
      <WithProviders>
        <AnimatedNumber value={1234} format={(n) => n.toLocaleString('en-US')} />
      </WithProviders>,
    );
    expect(screen.getByText('1,234')).toBeInTheDocument();
  });
});

describe('ProgressRing', () => {
  it('renders SVG ring', () => {
    const { container } = render(
      <WithProviders>
        <ProgressRing value={75} size={80} strokeWidth={6} />
      </WithProviders>,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('renders children inside the ring', () => {
    render(
      <WithProviders>
        <ProgressRing value={50}>
          <span>50%</span>
        </ProgressRing>
      </WithProviders>,
    );
    expect(screen.getByText('50%')).toBeInTheDocument();
  });
});
