import { Compass, Home } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center animate-[fade-in_400ms_var(--ease-out-expo)]">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-6 flex size-16 items-center justify-center rounded-[--radius-xl] bg-accent-500/10">
          <Compass className="size-8 text-accent-400" />
        </div>
        <h2 className="font-[--font-display] text-[length:--text-4xl] font-bold text-text-primary">
          404
        </h2>
        <p className="mt-2 font-[--font-display] text-[length:--text-xl] text-text-secondary">
          Page not found
        </p>
        <p className="mt-2 text-[length:--text-sm] text-text-muted">
          This chapter hasn&apos;t been written yet.
        </p>
        <div className="mt-6">
          <Button asChild>
            <a href="/">
              <Home className="mr-2 size-4" />
              Return to Dashboard
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}
