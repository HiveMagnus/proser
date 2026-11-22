import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-all duration-[--duration-normal] cursor-pointer disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-accent-500 text-surface-base hover:bg-accent-400 shadow-sm active:bg-accent-600',
        secondary:
          'bg-surface-raised text-text-primary border border-border-default hover:bg-surface-hover hover:border-border-strong active:bg-surface-active',
        ghost:
          'text-text-secondary hover:text-text-primary hover:bg-surface-hover active:bg-surface-active',
        danger:
          'bg-danger/10 text-danger border border-danger/20 hover:bg-danger/20 hover:border-danger/30 active:bg-danger/30',
        link: 'text-accent-400 underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 rounded-[--radius-sm] px-3 text-[length:--text-xs]',
        md: 'h-9 rounded-[--radius-md] px-4 text-[length:--text-sm]',
        lg: 'h-11 rounded-[--radius-md] px-6 text-[length:--text-base]',
        icon: 'size-9 rounded-[--radius-md]',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
