import type { NegotiatedDocumentCapabilities } from '@/lib/document-api';
export const documentCapabilitiesFixture = (
  patch: Partial<NegotiatedDocumentCapabilities> = {},
): NegotiatedDocumentCapabilities => ({
  globalSearch: 'manifest-cursor-v1',
  passages: 'run-window-v1',
  orderedPassages: 'ordered-window-v1',
  passageOperations: 'typed-operations-v1',
  searchIndex: 'revision-gin-v1',
  enabled: true,
  schemaVersion: 1,
  actorId: 7,
  revisionPreview: 'disclosed-proposal-v1',
  revisionSource: 'immutable-manifest-v1',
  projection: 'final',
  maxDocumentBytes: 2 * 1024 * 1024,
  maxCommitBytes: 8 * 1024 * 1024,
  ...patch,
});
