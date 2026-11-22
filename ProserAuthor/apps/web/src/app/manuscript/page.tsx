'use client';
import { Suspense } from 'react';
import { ManuscriptEntry } from '@/components/editor/manuscript-entry';

export default function ManuscriptPage() {
  return (
    <Suspense fallback={<p role="status">Loading manuscript…</p>}>
      <ManuscriptEntry />
    </Suspense>
  );
}
