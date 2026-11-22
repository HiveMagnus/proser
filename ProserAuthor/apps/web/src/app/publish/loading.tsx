import { Skeleton } from '@/components/ui/loading';

export default function PublishLoading() {
  return (
    <div className="space-y-6 animate-[fade-in_200ms_ease-out]">
      <div className="space-y-2">
        <Skeleton className="h-9 w-44" />
        <Skeleton className="h-4 w-60" />
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="rounded-[--radius-lg] border border-border-muted bg-surface-raised p-5 space-y-3 text-center"
          >
            <Skeleton className="mx-auto size-10 rounded-[--radius-md]" />
            <Skeleton className="mx-auto h-4 w-16" />
          </div>
        ))}
      </div>

      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center justify-between rounded-[--radius-lg] border border-border-muted bg-surface-raised p-4"
          >
            <div className="flex items-center gap-3">
              <Skeleton className="size-8 rounded-[--radius-md]" />
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-32" />
              </div>
            </div>
            <Skeleton className="h-8 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}
