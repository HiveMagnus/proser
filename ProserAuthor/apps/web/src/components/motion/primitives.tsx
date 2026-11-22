'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useMotion } from '@/contexts/motion-context';

/* ── Fade In ──────────────────────────────────────── */
interface FadeInProps {
  children: React.ReactNode;
  delay?: number;
  duration?: number;
  className?: string;
}

export function FadeIn({ children, delay = 0, duration = 0.4, className }: FadeInProps) {
  const { shouldAnimate } = useMotion();
  if (!shouldAnimate) return <div className={className}>{children}</div>;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration, delay, ease: [0.16, 1, 0.3, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/* ── Stagger Children ─────────────────────────────── */
interface StaggerProps {
  children: React.ReactNode;
  stagger?: number;
  className?: string;
}

export function StaggerChildren({ children, stagger = 0.06, className }: StaggerProps) {
  const { shouldAnimate } = useMotion();
  if (!shouldAnimate) return <div className={className}>{children}</div>;
  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={{ visible: { transition: { staggerChildren: stagger } } }}
      className={className}
    >
      {React.Children.map(children, (child) => (
        <motion.div
          variants={{
            hidden: { opacity: 0, y: 12 },
            visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.16, 1, 0.3, 1] } },
          }}
        >
          {child}
        </motion.div>
      ))}
    </motion.div>
  );
}

/* ── Page Transition ──────────────────────────────── */
interface PageTransitionProps {
  children: React.ReactNode;
  transitionKey?: string;
  className?: string;
}

export function PageTransition({ children, transitionKey, className }: PageTransitionProps) {
  const { shouldAnimate } = useMotion();
  if (!shouldAnimate) return <div className={className}>{children}</div>;
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={transitionKey ?? 'page'}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        className={className}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}

/* ── Panel Transition ─────────────────────────────── */
interface PanelTransitionProps {
  open: boolean;
  children: React.ReactNode;
  direction?: 'left' | 'right' | 'up' | 'down';
  className?: string;
}

export function PanelTransition({
  open,
  children,
  direction = 'right',
  className,
}: PanelTransitionProps) {
  const { shouldAnimate } = useMotion();
  const offsets = { left: { x: -20 }, right: { x: 20 }, up: { y: -20 }, down: { y: 20 } };

  if (!shouldAnimate) return open ? <div className={className}>{children}</div> : null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, ...offsets[direction] }}
          animate={{ opacity: 1, x: 0, y: 0 }}
          exit={{ opacity: 0, ...offsets[direction] }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          className={className}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ── Animated Number ──────────────────────────────── */
interface AnimatedNumberProps {
  value: number;
  duration?: number;
  className?: string;
  format?: (n: number) => string;
}

export function AnimatedNumber({ value, duration = 0.8, className, format }: AnimatedNumberProps) {
  const { shouldAnimate } = useMotion();
  const [display, setDisplay] = React.useState(shouldAnimate ? 0 : value);

  React.useEffect(() => {
    if (!shouldAnimate) {
      setDisplay(value);
      return;
    }
    const start = Date.now();
    const from = display;
    const step = () => {
      const elapsed = (Date.now() - start) / 1000;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(from + (value - from) * eased));
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, shouldAnimate]);

  return <span className={className}>{format ? format(display) : display.toLocaleString()}</span>;
}

/* ── Progress Ring ────────────────────────────────── */
interface ProgressRingProps {
  value: number; // 0-100
  size?: number;
  strokeWidth?: number;
  className?: string;
  color?: string;
  children?: React.ReactNode;
}

export function ProgressRing({
  value,
  size = 100,
  strokeWidth = 8,
  className,
  color = 'var(--color-accent-400)',
  children,
}: ProgressRingProps) {
  const { shouldAnimate } = useMotion();
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const [offset, setOffset] = React.useState(
    shouldAnimate ? circumference : circumference - (value / 100) * circumference,
  );

  React.useEffect(() => {
    const target = circumference - (value / 100) * circumference;
    if (!shouldAnimate) {
      setOffset(target);
      return;
    }
    const timeout = setTimeout(() => setOffset(target), 100);
    return () => clearTimeout(timeout);
  }, [value, circumference, shouldAnimate]);

  return (
    <div className={className} style={{ width: size, height: size, position: 'relative' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--color-border-muted)"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{
            transition: shouldAnimate ? 'stroke-dashoffset 1s cubic-bezier(0.16,1,0.3,1)' : 'none',
          }}
        />
      </svg>
      {children && (
        <div className="absolute inset-0 flex items-center justify-center">{children}</div>
      )}
    </div>
  );
}
