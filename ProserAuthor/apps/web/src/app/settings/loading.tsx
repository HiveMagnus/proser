import { Skeleton } from '@/components/ui/loading';

export default function SettingsLoading() {
  return (
    <div className="space-y-6 animate-[fade-in_200ms_ease-out]">
      <div className="space-y-2">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-4 w-56" />
      </div>

      <Skeleton className="h-10 w-72" />

      <div className="rounded-[--radius-lg] border border-border-muted bg-surface-raised p-6 space-y-5">
        <Skeleton className="h-6 w-32" />
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
        </div>
        <Skeleton className="h-9 w-24" />
      </div>
    </div>
  );
}
