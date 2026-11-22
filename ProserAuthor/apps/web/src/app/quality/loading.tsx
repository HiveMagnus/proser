import { Skeleton } from '@/components/ui/loading';

export default function QualityLoading() {
  return (
    <div className="space-y-6 animate-[fade-in_200ms_ease-out]">
      <div className="flex items-end justify-between">
        <div className="space-y-2">
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-32" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-[--radius-lg] border border-border-muted bg-surface-raised p-5"
          >
            <Skeleton className="mb-2 h-3 w-20" />
            <Skeleton className="h-7 w-16" />
          </div>
        ))}
      </div>

      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="rounded-[--radius-lg] border border-border-muted bg-surface-raised p-4 space-y-2"
          >
            <div className="flex items-center justify-between">
              <Skeleton className="h-5 w-56" />
              <Skeleton className="h-6 w-12" />
            </div>
            <Skeleton className="h-2 w-full rounded-[--radius-full]" />
          </div>
        ))}
      </div>
    </div>
  );
}
