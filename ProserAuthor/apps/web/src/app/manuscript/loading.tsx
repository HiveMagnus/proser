import { Skeleton } from '@/components/ui/loading';

export default function ManuscriptLoading() {
  return (
    <div className="flex gap-4 animate-[fade-in_200ms_ease-out]">
      {/* Scene tree sidebar */}
      <div className="w-64 shrink-0 space-y-3 rounded-[--radius-lg] border border-border-muted bg-surface-raised p-4">
        <Skeleton className="h-5 w-32" />
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2 pl-2">
            <Skeleton className="size-4" />
            <Skeleton className="h-4 w-full" />
          </div>
        ))}
      </div>

      {/* Editor area */}
      <div className="flex-1 space-y-4 rounded-[--radius-lg] border border-border-muted bg-surface-raised p-6">
        <Skeleton className="h-7 w-64" />
        <div className="space-y-2">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="h-4" style={{ width: `${60 + Math.random() * 40}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}
