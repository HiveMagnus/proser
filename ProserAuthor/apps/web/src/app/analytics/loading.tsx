import { Skeleton } from '@/components/ui/loading';

export default function AnalyticsLoading() {
  return (
    <div className="space-y-6 animate-[fade-in_200ms_ease-out]">
      <div className="space-y-2">
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-4 w-56" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-[--radius-lg] border border-border-muted bg-surface-raised p-5"
          >
            <Skeleton className="mb-2 h-3 w-24" />
            <Skeleton className="h-7 w-20" />
            <Skeleton className="mt-1 h-3 w-32" />
          </div>
        ))}
      </div>

      {/* Chart placeholder */}
      <div className="rounded-[--radius-lg] border border-border-muted bg-surface-raised p-6">
        <Skeleton className="mb-4 h-5 w-40" />
        <div className="flex items-end gap-2 h-48">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton
              key={i}
              className="flex-1 rounded-t-[--radius-sm]"
              style={{ height: `${30 + ((i * 37) % 60)}%` }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
