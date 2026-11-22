import * as React from 'react';
import { cn } from '@/lib/utils';
import { Separator } from './separator';

/* ─── Toolbar ────────────────────────────────────────────────
   A horizontal bar for grouping actions, typically used in
   editor interfaces. Supports groups of items with separators.
   ──────────────────────────────────────────────────────────── */

type ToolbarProps = React.HTMLAttributes<HTMLDivElement>;

const Toolbar = React.forwardRef<HTMLDivElement, ToolbarProps>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    role="toolbar"
    className={cn(
      'flex items-center gap-1 rounded-[--radius-md] border border-border-muted bg-surface-raised px-2 py-1.5',
      className,
    )}
    {...props}
  />
));
Toolbar.displayName = 'Toolbar';

const ToolbarGroup = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('flex items-center gap-0.5', className)} {...props} />
  ),
);
ToolbarGroup.displayName = 'ToolbarGroup';

const ToolbarSeparator = () => <Separator orientation="vertical" className="mx-1 h-5" />;

interface ToolbarButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean;
}

const ToolbarButton = React.forwardRef<HTMLButtonElement, ToolbarButtonProps>(
  ({ className, active, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-[--radius-sm]',
        'text-[length:--text-sm] transition-colors duration-[--duration-fast] cursor-pointer',
        active
          ? 'bg-accent-500/15 text-accent-300'
          : 'text-text-muted hover:text-text-primary hover:bg-surface-hover',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
ToolbarButton.displayName = 'ToolbarButton';

export { Toolbar, ToolbarGroup, ToolbarSeparator, ToolbarButton };
