import { Skeleton } from '@/components/ui/loading';

export default function ContinuityLoading() {
  return (
    <div className="space-y-6 animate-[fade-in_200ms_ease-out]">
      <div className="flex items-end justify-between">
        <div className="space-y-2">
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-9 w-36" />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-[--radius-lg] border border-border-muted bg-surface-raised p-5"
          >
            <Skeleton className="mb-2 h-3 w-20" />
            <Skeleton className="h-7 w-12" />
          </div>
        ))}
      </div>

      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="flex items-start gap-4 rounded-[--radius-lg] border border-border-muted bg-surface-raised p-4"
          >
            <Skeleton className="size-8 rounded-[--radius-md] shrink-0" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            <Skeleton className="h-6 w-16 rounded-[--radius-full]" />
          </div>
        ))}
      </div>
    </div>
  );
}
