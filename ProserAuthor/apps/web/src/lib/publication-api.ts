import type {
  DocumentPublicationCapabilities,
  DocumentPublicationRequest,
  DocumentPublicationJob,
  DocumentDocxImportPreview,
  DocumentDocxImportCommitRequest,
  DocumentTextImportFormat,
  DocumentTextImportPreview,
  DocumentTextImportCommitRequest,
} from '@hivemagnus/proser-contracts';
async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch(url, {
    ...options,
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const reader = response.body?.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  if (reader)
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new Error('Publication response exceeds the supported size.');
      }
      parts.push(value);
    }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  const body = JSON.parse(new TextDecoder().decode(bytes)) as {
    success?: boolean;
    ok?: boolean;
    data: T;
    error?: { message?: string } | string;
  };
  if (!response.ok || !(body.success ?? body.ok))
    throw new Error(
      typeof body.error === 'string'
        ? body.error
        : (body.error?.message ?? `Factory returned ${response.status}.`),
    );
  return body.data;
}
const base = (bookId: string) => `/api/books/${encodeURIComponent(bookId)}`;
export const getPublicationCapabilities = (bookId: string, signal?: AbortSignal) =>
  request<DocumentPublicationCapabilities>(`${base(bookId)}/document-publication-capabilities`, {
    signal,
  });
export const createPublication = (
  bookId: string,
  input: DocumentPublicationRequest,
  signal?: AbortSignal,
) =>
  request<DocumentPublicationJob>(`${base(bookId)}/document-publication-jobs`, {
    method: 'POST',
    body: JSON.stringify(input),
    signal,
  });
export const getPublication = (bookId: string, id: string, signal?: AbortSignal) =>
  request<DocumentPublicationJob>(
    `${base(bookId)}/document-publication-jobs/${encodeURIComponent(id)}`,
    { signal },
  );
export const listPublications = (bookId: string, signal?: AbortSignal, cursor?: string) =>
  request<{ jobs: DocumentPublicationJob[]; nextCursor: string | null }>(
    `${base(bookId)}/document-publication-jobs${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    { signal },
  );
export const resumePublication = (bookId: string, id: string, signal?: AbortSignal) =>
  request<DocumentPublicationJob>(
    `${base(bookId)}/document-publication-jobs/${encodeURIComponent(id)}/resume`,
    { method: 'POST', body: '{}', signal },
  );
export const cancelPublication = (bookId: string, id: string, signal?: AbortSignal) =>
  request<DocumentPublicationJob>(
    `${base(bookId)}/document-publication-jobs/${encodeURIComponent(id)}/cancel`,
    { method: 'POST', body: '{}', signal },
  );
export async function previewDocx(
  bookId: string,
  file: File,
  revisionId: string,
  signal?: AbortSignal,
) {
  if (!file.size || file.size > 32 * 1024 * 1024)
    throw new Error('DOCX uploads must contain 1 byte to 32 MiB.');
  const originalId = crypto.randomUUID();
  await request(`${base(bookId)}/docx-import-originals/${originalId}`, {
    method: 'POST',
    body: file,
    headers: { 'Content-Type': 'application/octet-stream' },
    signal,
  });
  const operationId = crypto.randomUUID();
  return request<DocumentDocxImportPreview>(`${base(bookId)}/docx-import-previews`, {
    method: 'POST',
    body: JSON.stringify({ operationId, originalId, expectedRevisionId: revisionId }),
    signal,
  });
}
export const commitDocx = (
  bookId: string,
  preview: DocumentDocxImportPreview,
  expectedScopes: DocumentDocxImportCommitRequest['expectedScopes'],
  operationId: string,
  signal?: AbortSignal,
) =>
  request(`${base(bookId)}/docx-import-previews/${preview.id}/commit`, {
    method: 'POST',
    body: JSON.stringify({
      operationId,
      expectedRevisionId: preview.sourceBookRevisionId,
      expectedScopes,
      consentReportHash: preview.reportHash,
    }),
    signal,
  });
/** The text format a manuscript file is imported as, by its extension. */
export function textImportFormat(file: File): DocumentTextImportFormat | null {
  const name = file.name.toLowerCase();
  if (/\.(md|markdown|mdown|mkd)$/.test(name)) return 'markdown';
  if (/\.(txt|text)$/.test(name)) return 'plain-text';
  return null;
}
export async function previewTextManuscript(
  bookId: string,
  file: File,
  revisionId: string,
  signal?: AbortSignal,
) {
  const format = textImportFormat(file);
  if (!format) throw new Error('Choose a Markdown (.md) or plain-text (.txt) file.');
  if (!file.size || file.size > 32 * 1024 * 1024)
    throw new Error('Manuscript files must contain 1 byte to 32 MiB.');
  const originalId = crypto.randomUUID();
  await request(`${base(bookId)}/import-originals/${originalId}?format=${format}`, {
    method: 'POST',
    body: file,
    headers: { 'Content-Type': 'application/octet-stream' },
    signal,
  });
  const operationId = crypto.randomUUID();
  return request<DocumentTextImportPreview>(`${base(bookId)}/import-previews`, {
    method: 'POST',
    body: JSON.stringify({ operationId, originalId, expectedRevisionId: revisionId }),
    signal,
  });
}
export const commitTextManuscript = (
  bookId: string,
  preview: DocumentTextImportPreview,
  expectedScopes: DocumentTextImportCommitRequest['expectedScopes'],
  operationId: string,
  signal?: AbortSignal,
) =>
  request(`${base(bookId)}/import-previews/${preview.id}/commit`, {
    method: 'POST',
    body: JSON.stringify({
      operationId,
      expectedRevisionId: preview.sourceBookRevisionId,
      expectedScopes,
      consentReportHash: preview.reportHash,
    } satisfies DocumentTextImportCommitRequest),
    signal,
  });

export const BOOK_ARCHIVE_MAX_BYTES = 128 * 1024 * 1024;
export interface BookArchiveImportReceipt {
  operationId: string;
  bookId: number;
  title: string | null;
  revisionId: string;
  status: 'completed';
  counts: {
    acts: number;
    chapters: number;
    scenes: number;
    codex: number;
    notes: number;
    plotThreads: number;
    images: number;
    wordCount: number;
  };
  losses: { resolvedReviewFolded: number; commentsDropped: number; plainTextFallbacks: number };
}
/** Same-origin download path of a book's portable archive. */
export const bookArchiveUrl = (bookId: string) => `${base(bookId)}/archive`;
/** Import a book archive as a new book. Retrying with the same operation ID
 * returns the original receipt instead of importing twice. */
export async function importBookArchive(file: File, operationId: string, signal?: AbortSignal) {
  if (!file.size || file.size > BOOK_ARCHIVE_MAX_BYTES)
    throw new Error('Book archives must contain 1 byte to 128 MiB.');
  const timeout = AbortSignal.timeout(5 * 60_000);
  const response = await fetch(
    `/api/books/archive-imports?operationId=${encodeURIComponent(operationId)}`,
    {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': 'application/zip' },
      cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    },
  );
  const body = (await response.json().catch(() => null)) as {
    success?: boolean;
    data?: BookArchiveImportReceipt;
    error?: string | { message?: string };
  } | null;
  if (!response.ok || !body?.success || !body.data) {
    const message = typeof body?.error === 'string' ? body.error : body?.error?.message;
    throw new Error(message || `Book archive import failed (${response.status}).`);
  }
  return body.data;
}
