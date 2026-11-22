import { Skeleton } from '@/components/ui/loading';

export default function BibleLoading() {
  return (
    <div className="space-y-6 animate-[fade-in_200ms_ease-out]">
      <div className="flex items-end justify-between">
        <div className="space-y-2">
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>

      <div className="flex items-center gap-3">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-9 w-32" />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="rounded-[--radius-lg] border border-border-muted bg-surface-raised p-5 space-y-3"
          >
            <div className="flex items-center gap-3">
              <Skeleton className="size-10 rounded-[--radius-md]" />
              <div className="space-y-1.5 flex-1">
                <Skeleton className="h-5 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
            <div className="flex gap-2 pt-1">
              <Skeleton className="h-5 w-16 rounded-[--radius-full]" />
              <Skeleton className="h-5 w-20 rounded-[--radius-full]" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
