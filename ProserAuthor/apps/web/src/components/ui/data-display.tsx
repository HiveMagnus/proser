import * as React from 'react';
import { cn } from '@/lib/utils';

function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-16 text-center', className)}>
      {icon && (
        <div className="mb-4 flex size-14 items-center justify-center rounded-[--radius-xl] bg-surface-raised text-text-muted">
          {icon}
        </div>
      )}
      <h3 className="text-[length:--text-lg] font-semibold text-text-primary">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-[length:--text-sm] text-text-secondary">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

function StatCard({
  label,
  value,
  sublabel,
  trend,
  className,
}: {
  label: string;
  value: React.ReactNode;
  sublabel?: string;
  trend?: 'up' | 'down' | 'neutral';
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-[--radius-lg] border border-border-default bg-surface-raised p-4',
        className,
      )}
    >
      <p className="text-[length:--text-xs] font-medium text-text-muted uppercase tracking-wider">
        {label}
      </p>
      <p className="mt-1 text-[length:--text-2xl] font-bold font-[--font-display] text-text-primary">
        {value}
        {trend && (
          <span
            className={cn(
              'ml-2 text-[length:--text-xs] font-normal',
              trend === 'up' && 'text-success',
              trend === 'down' && 'text-danger',
              trend === 'neutral' && 'text-text-muted',
            )}
          >
            {trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→'}
          </span>
        )}
      </p>
      {sublabel && <p className="mt-0.5 text-[length:--text-xs] text-text-muted">{sublabel}</p>}
    </div>
  );
}

export { EmptyState, StatCard };
