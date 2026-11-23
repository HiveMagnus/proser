const MIB = 1024 * 1024;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Preserved import originals are append-only and have no delete API, so the
 * bytes one account or one book may retain must be bounded.
 */
export function importOriginalQuota(environment: NodeJS.ProcessEnv = process.env) {
  return {
    bookBytes: positiveInteger(environment.IMPORT_ORIGINALS_BOOK_QUOTA_BYTES, 512 * MIB),
    userBytes: positiveInteger(environment.IMPORT_ORIGINALS_USER_QUOTA_BYTES, 2048 * MIB),
  };
}

/** Imported images stay on disk, including superseded revisions. */
export function importedImageQuota(environment: NodeJS.ProcessEnv = process.env) {
  return {
    bookCount: positiveInteger(environment.IMAGE_IMPORTS_BOOK_LIMIT, 500),
    userCount: positiveInteger(environment.IMAGE_IMPORTS_USER_LIMIT, 5000),
  };
}
