'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { AlertCircle, RefreshCw, Inbox } from 'lucide-react';

/* ── Error Panel ──────────────────────────────────── */
interface ErrorPanelProps {
  error: Error | string | null;
  onRetry?: () => void;
  className?: string;
}

export function ErrorPanel({ error, onRetry, className }: ErrorPanelProps) {
  const message = error instanceof Error ? error.message : (error ?? 'Something went wrong');
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-4 rounded-[--radius-lg] border border-danger/30 bg-danger/5 p-8 text-center',
        className,
      )}
    >
      <AlertCircle className="size-10 text-danger" />
      <div>
        <p className="text-[length:--text-base] font-medium text-text-primary">An error occurred</p>
        <p className="mt-1 text-[length:--text-sm] text-text-muted">{message}</p>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="inline-flex items-center gap-2 rounded-[--radius-md] bg-surface-raised px-4 py-2 text-[length:--text-sm] font-medium text-text-primary hover:bg-surface-hover transition-colors cursor-pointer"
        >
          <RefreshCw className="size-4" /> Retry
        </button>
      )}
    </div>
  );
}

/* ── Empty State ──────────────────────────────────── */
interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 rounded-[--radius-lg] border border-border-muted border-dashed bg-surface-sunken/50 p-12 text-center',
        className,
      )}
    >
      {icon ?? <Inbox className="size-10 text-text-muted" />}
      <p className="text-[length:--text-base] font-medium text-text-primary">{title}</p>
      {description && (
        <p className="max-w-md text-[length:--text-sm] text-text-muted">{description}</p>
      )}
      {action}
    </div>
  );
}

/* ── Stale Banner ─────────────────────────────────── */
interface StaleBannerProps {
  lastSuccessful?: string | null;
  onRefresh?: () => void;
  className?: string;
}

export function StaleBanner({ lastSuccessful, onRefresh, className }: StaleBannerProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-[--radius-md] border border-warning/30 bg-warning/5 px-4 py-2 text-[length:--text-sm]',
        className,
      )}
    >
      <span className="text-warning">⚠</span>
      <span className="flex-1 text-text-secondary">
        Data may be outdated.{' '}
        {lastSuccessful && (
          <span className="text-text-muted">
            Last updated {new Date(lastSuccessful).toLocaleString()}
          </span>
        )}
      </span>
      {onRefresh && (
        <button
          onClick={onRefresh}
          className="inline-flex items-center gap-1 text-accent-400 hover:text-accent-300 transition-colors cursor-pointer"
        >
          <RefreshCw className="size-3.5" /> Refresh
        </button>
      )}
    </div>
  );
}

/* ── Loading Skeleton ─────────────────────────────── */
interface LoadingSkeletonProps {
  variant?: 'card' | 'list' | 'table' | 'chart' | 'text';
  rows?: number;
  className?: string;
}

export function LoadingSkeleton({ variant = 'card', rows = 3, className }: LoadingSkeletonProps) {
  const pulse = 'animate-pulse rounded-[--radius-md] bg-surface-hover';

  if (variant === 'text') {
    return (
      <div className={cn('space-y-3', className)}>
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className={cn(pulse, 'h-4')}
            style={{ width: `${70 + Math.random() * 30}%` }}
          />
        ))}
      </div>
    );
  }

  if (variant === 'list') {
    return (
      <div className={cn('space-y-3', className)}>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <div className={cn(pulse, 'size-8 shrink-0 rounded-full')} />
            <div className="flex-1 space-y-2">
              <div className={cn(pulse, 'h-4 w-2/3')} />
              <div className={cn(pulse, 'h-3 w-1/3')} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (variant === 'chart') {
    return (
      <div className={cn('flex items-end gap-2 h-40', className)}>
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className={cn(pulse, 'flex-1')}
            style={{ height: `${20 + Math.random() * 80}%` }}
          />
        ))}
      </div>
    );
  }

  if (variant === 'table') {
    return (
      <div className={cn('space-y-2', className)}>
        <div className={cn(pulse, 'h-10 w-full')} />
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className={cn(pulse, 'h-8 w-full')} />
        ))}
      </div>
    );
  }

  // card variant
  return (
    <div className={cn('grid gap-4 sm:grid-cols-2 lg:grid-cols-3', className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="rounded-[--radius-lg] border border-border-muted bg-surface-raised p-6 space-y-3"
        >
          <div className={cn(pulse, 'h-5 w-1/2')} />
          <div className={cn(pulse, 'h-4 w-3/4')} />
          <div className={cn(pulse, 'h-3 w-1/3')} />
        </div>
      ))}
    </div>
  );
}

/* ── Async Boundary ───────────────────────────────── */
interface AsyncBoundaryProps {
  isLoading: boolean;
  error?: Error | string | null;
  isEmpty?: boolean;
  isStale?: boolean;
  onRetry?: () => void;
  onRefresh?: () => void;
  lastSuccessful?: string | null;
  loadingFallback?: React.ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyIcon?: React.ReactNode;
  emptyAction?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function AsyncBoundary({
  isLoading,
  error,
  isEmpty,
  isStale,
  onRetry,
  onRefresh,
  lastSuccessful,
  loadingFallback,
  emptyTitle = 'No data yet',
  emptyDescription,
  emptyIcon,
  emptyAction,
  children,
  className,
}: AsyncBoundaryProps) {
  if (isLoading) return <>{loadingFallback ?? <LoadingSkeleton className={className} />}</>;
  if (error) return <ErrorPanel error={error} onRetry={onRetry} className={className} />;
  if (isEmpty) {
    return (
      <EmptyState
        icon={emptyIcon}
        title={emptyTitle}
        description={emptyDescription}
        action={emptyAction}
        className={className}
      />
    );
  }

  return (
    <>
      {isStale && <StaleBanner lastSuccessful={lastSuccessful} onRefresh={onRefresh} />}
      {children}
    </>
  );
}
