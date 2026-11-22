import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import PublishPage from '@/app/publish/page';
import { useWorkspace } from '@/contexts/workspace-context';
import { useSession } from 'next-auth/react';
import { getDocumentManifest } from '@/lib/document-api';
import {
  getPublicationCapabilities,
  listPublications,
  createPublication,
  getPublication,
  previewDocx,
  commitDocx,
} from '@/lib/publication-api';
vi.mock('@/contexts/workspace-context', () => ({ useWorkspace: vi.fn() }));
vi.mock('next-auth/react', () => ({ useSession: vi.fn() }));
vi.mock('@/lib/document-api', () => ({ getDocumentManifest: vi.fn() }));
vi.mock('@/lib/publication-api', () => ({
  getPublicationCapabilities: vi.fn(),
  listPublications: vi.fn(),
  createPublication: vi.fn(),
  getPublication: vi.fn(),
  resumePublication: vi.fn(),
  cancelPublication: vi.fn(),
  previewDocx: vi.fn(),
  commitDocx: vi.fn(),
}));
describe('Factory-driven publication workspace', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(useWorkspace).mockReturnValue({ activeBookId: '42' } as ReturnType<
      typeof useWorkspace
    >);
    vi.mocked(useSession).mockReturnValue({
      data: { user: { id: 'owner' }, expires: '2099-01-01T00:00:00.000Z' },
      status: 'authenticated',
      update: vi.fn(),
    } as ReturnType<typeof useSession>);
    vi.mocked(getPublicationCapabilities).mockResolvedValue({
      schemaVersion: 1,
      modes: ['retain-review', 'final', 'original'],
      presets: ['saved', 'submission-manuscript', 'print-book'],
      formats: [
        {
          format: 'docx',
          extension: 'docx',
          mediaType: 'application/docx',
          available: true,
          reason: null,
          review: 'native',
        },
        {
          format: 'pdf',
          extension: 'pdf',
          mediaType: 'application/pdf',
          available: false,
          reason: 'Renderer is unavailable.',
          review: 'visual-markup',
        },
      ],
      codecVersion: 'fixture',
      rendererVersion: 'fixture',
      wordAcceptance: 'unverified',
    });
    vi.mocked(listPublications).mockResolvedValue({ jobs: [], nextCursor: null });
    vi.mocked(getDocumentManifest).mockResolvedValue({
      schemaVersion: 1,
      revisionId: 'saved-revision',
      contentHash: 'digest',
      scenes: [],
      scopes: {
        structure: { revisionId: 'structure', contentHash: 's' },
        canon: { revisionId: 'canon', contentHash: 'c' },
        layout: { revisionId: 'layout', contentHash: 'l' },
      },
      totals: { projection: 'final', wordCount: 0, sceneCount: 0 },
    });
  });
  afterEach(() => cleanup());
  it('shows specific artifact losses and actual font substitutions beside downloads', async () => {
    vi.mocked(listPublications).mockResolvedValue({
      nextCursor: null,
      jobs: [
        {
          id: 'complete',
          sourceRevisionId: 'saved-revision',
          sourceHash: 'hash',
          status: 'completed',
          options: { format: 'pdf', mode: 'original', preset: 'saved' },
          errorCode: null,
          errorMessage: null,
          createdAt: '2026-01-01',
          artifactId: 'a',
          downloadPath: '/api/download',
          reviewSidecarPath: null,
          fidelity: {
            losses: ['One detached comment is retained in review data.'],
            fontSubstitutions: [{ requested: 'Unavailable font', actual: 'Liberation Serif' }],
            wordAcceptance: 'unverified',
          },
        },
      ],
    });
    render(<PublishPage />);
    expect(
      await screen.findByText('One detached comment is retained in review data.'),
    ).toBeVisible();
    expect(screen.getByText('Font Unavailable font rendered as Liberation Serif.')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Download artifact' })).toBeVisible();
  });
  it('uses Factory availability and revision-bound operation IDs', async () => {
    vi.mocked(createPublication).mockResolvedValue({
      id: 'job1',
      sourceRevisionId: 'saved-revision',
      sourceHash: 'hash',
      status: 'completed',
      options: { format: 'docx', mode: 'final', preset: 'saved' },
      errorCode: null,
      errorMessage: null,
      createdAt: '2026-01-01',
      artifactId: 'artifact1',
      downloadPath: '/api/books/42/document-publication-artifacts/artifact1/download',
      reviewSidecarPath: null,
    });
    render(<PublishPage />);
    await screen.findByRole('button', { name: 'Create export' });
    expect(screen.getByRole('option', { name: 'PDF — unavailable' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Create export' }));
    await screen.findByRole('link', { name: 'Download artifact' });
    expect(createPublication).toHaveBeenCalledWith(
      '42',
      expect.objectContaining({
        operationId: expect.any(String),
        expectedRevisionId: 'saved-revision',
        options: { format: 'docx', mode: 'final', preset: 'saved' },
      }),
      expect.any(AbortSignal),
    );
  });
  it.each([
    ['RENDER_FAILED', 'Renderer failed to package images.'],
    [
      'PUBLICATION_GLYPH_UNAVAILABLE',
      'Verified rendered faces lack required glyphs; publication needs a pinned font with coverage.',
    ],
    [
      'PUBLICATION_GLYPH_FONT_UNPINNED',
      'Rendering requires an unpinned CJK glyph font. Install a licensed, pinned fallback before publication.',
    ],
  ])(
    'shows failed export %s with durable job IDs and recovery actions',
    async (errorCode, errorMessage) => {
      vi.mocked(listPublications).mockResolvedValue({
        jobs: [
          {
            id: 'recover-job',
            sourceRevisionId: 'revision',
            sourceHash: 'hash',
            status: 'failed',
            options: { format: 'docx', mode: 'final', preset: 'saved' },
            errorCode,
            errorMessage,
            createdAt: '2026-01-01',
            artifactId: null,
            downloadPath: null,
            reviewSidecarPath: null,
          },
        ],
        nextCursor: null,
      });
      render(<PublishPage />);
      await screen.findByText(errorMessage);
      expect(screen.getByText(/recover-job/)).toBeVisible();
      expect(screen.getByRole('button', { name: 'Recover / resume job' })).toBeEnabled();
    },
  );
  it('recovers interrupted acknowledgements from the original operation', async () => {
    vi.mocked(createPublication).mockRejectedValue(new Error('Network failed.'));
    vi.mocked(getPublication).mockResolvedValue({
      id: 'recovered',
      sourceRevisionId: 'revision',
      sourceHash: 'hash',
      status: 'completed',
      options: { format: 'docx', mode: 'final', preset: 'saved' },
      errorCode: null,
      errorMessage: null,
      createdAt: '2026-01-01',
      artifactId: 'artifact',
      downloadPath: '/api/download',
      reviewSidecarPath: null,
    });
    render(<PublishPage />);
    await screen.findByRole('button', { name: 'Create export' });
    fireEvent.click(screen.getByRole('button', { name: 'Create export' }));
    await screen.findByRole('link', { name: 'Download artifact' });
    expect(getPublication).toHaveBeenCalledWith(
      '42',
      vi.mocked(createPublication).mock.calls[0]![1].operationId,
      expect.any(AbortSignal),
    );
    expect(createPublication).toHaveBeenCalledTimes(1);
  });
  it('requires loss consent and commits the reviewed mapping with source scopes', async () => {
    vi.mocked(previewDocx).mockResolvedValue({
      id: 'preview',
      originalId: 'original',
      sourceBookRevisionId: 'saved-revision',
      reportHash: 'report',
      report: {
        schemaVersion: 1,
        format: 'docx',
        codecVersion: 'fixture',
        originalId: 'original',
        originalSha256: 'hash',
        convertedSha256: 'hash',
        strategy: 'append',
        chapterCount: 1,
        wordCount: 20,
        detected: [],
        losses: [
          { code: 'footnotes', count: 1, message: 'Footnotes remain only in the original.' },
        ],
        externalResourcesFetched: false,
        nativeParagraphRevisionAcceptance: 'unverified',
        mapping: [{ chapterIndex: 0, title: 'Chapter One', sceneCount: 1 }],
      },
      mapping: [{ chapterIndex: 0, title: 'Chapter One', sceneCount: 1 }],
      documents: [],
    });
    vi.mocked(commitDocx).mockResolvedValue({});
    render(<PublishPage />);
    await screen.findByRole('button', { name: 'Create export' });
    fireEvent.change(screen.getByLabelText('Choose DOCX file'), {
      target: { files: [new File(['fixture'], 'fixture.docx')] },
    });
    await screen.findByText('Footnotes remain only in the original. (1)');
    expect(screen.getByRole('button', { name: 'Commit reviewed import' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Commit reviewed import' }));
    await waitFor(() =>
      expect(commitDocx).toHaveBeenCalledWith(
        '42',
        expect.objectContaining({ id: 'preview', reportHash: 'report' }),
        { structure: 'structure', canon: 'canon', layout: 'layout' },
        expect.any(String),
        expect.any(AbortSignal),
      ),
    );
  });
  it('clears publication and preview state on authenticated account changes', async () => {
    const view = render(<PublishPage />);
    await screen.findByRole('button', { name: 'Create export' });
    vi.mocked(useSession).mockReturnValue({
      data: null,
      status: 'unauthenticated',
      update: vi.fn(),
    } as ReturnType<typeof useSession>);
    view.rerender(<PublishPage />);
    expect(screen.getByText('Sign in to access publication artifacts.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create export' })).toBeNull();
  });
});
