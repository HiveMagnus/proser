'use client';

import * as React from 'react';
import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

/* ─── Breadcrumbs ────────────────────────────────────────────
   Navigation trail component. Pass BreadcrumbItem children
   with href for links or without for the current page.
   ──────────────────────────────────────────────────────────── */

type BreadcrumbsProps = React.HTMLAttributes<HTMLElement>;

const Breadcrumbs = React.forwardRef<HTMLElement, BreadcrumbsProps>(
  ({ className, children, ...props }, ref) => (
    <nav
      ref={ref}
      aria-label="Breadcrumb"
      className={cn('flex items-center', className)}
      {...props}
    >
      <ol className="flex items-center gap-1 text-[length:--text-sm]">
        {React.Children.map(children, (child, index) => {
          const isLast = index === React.Children.count(children) - 1;
          return (
            <li className="flex items-center gap-1">
              {index > 0 && <ChevronRight className="size-3.5 text-text-muted" />}
              {isLast ? <span className="font-medium text-text-primary">{child}</span> : child}
            </li>
          );
        })}
      </ol>
    </nav>
  ),
);
Breadcrumbs.displayName = 'Breadcrumbs';

interface BreadcrumbItemProps {
  href?: string;
  children: React.ReactNode;
  className?: string;
}

function BreadcrumbItem({ href, children, className }: BreadcrumbItemProps) {
  if (href) {
    return (
      <Link
        href={href}
        className={cn(
          'text-text-muted transition-colors duration-[--duration-fast] hover:text-text-accent',
          className,
        )}
      >
        {children}
      </Link>
    );
  }
  return <span className={cn('text-text-primary', className)}>{children}</span>;
}

export { Breadcrumbs, BreadcrumbItem };
