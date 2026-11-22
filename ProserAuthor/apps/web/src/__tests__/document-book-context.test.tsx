import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentBookContext } from '@/components/editor/document-book-context';
import { getDocumentScope } from '@/lib/document-api';
const identity = vi.hoisted(() => ({ userId: 'author-one' as string | undefined }));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: identity.userId ? { user: { id: identity.userId } } : null }),
}));
vi.mock('@/lib/document-api', () => ({ getDocumentScope: vi.fn() }));
beforeEach(() => {
  vi.resetAllMocks();
  identity.userId = 'author-one';
});
const reference = { revisionId: 'canon-source', contentHash: 'canon-hash' };
const source = {
  revisionId: 'canon-source',
  contentHash: 'canon-hash',
  bookRevisionId: 'book-source',
  content: {
    schemaVersion: 1 as const,
    usages: [],
    entries: [
      {
        id: 1,
        entryType: 'character',
        entryName: 'Owned protagonist',
        entryDescription: '<script>Never interpreted</script>',
        attributes: '{"name":"é"}',
        deletedAt: null,
        createdAt: null,
      },
    ],
  },
};
describe('revision-bound manuscript context', () => {
  it('renders semantic saved context and immediately hides it when the author changes', async () => {
    vi.mocked(getDocumentScope).mockResolvedValue(source);
    const { rerender } = render(<DocumentBookContext bookId="1" reference={reference} />);
    expect(await screen.findByText('Owned protagonist')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
    identity.userId = undefined;
    rerender(<DocumentBookContext bookId="1" reference={reference} />);
    expect(screen.queryByText('Owned protagonist')).not.toBeInTheDocument();
  });
  it('rejects mismatched scope revisions or hashes instead of displaying a different context', async () => {
    vi.mocked(getDocumentScope).mockResolvedValue({ ...source, contentHash: 'changed-hash' });
    render(<DocumentBookContext bookId="1" reference={reference} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Book context changed');
    expect(screen.queryByText('Owned protagonist')).not.toBeInTheDocument();
  });
});
