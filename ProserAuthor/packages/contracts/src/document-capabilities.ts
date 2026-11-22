// Generated from Factory documents/capability-model.ts; edit Factory and run npm run documents:sync.
/** Authenticated Factory identity and negotiated structured contract. */
export interface DocumentCapabilities {
  schemaVersion: 1;
  enabled: boolean;
  actorId: number;
  revisionPreview: 'disclosed-proposal-v1';
  revisionSource: 'immutable-manifest-v1';
  projection: 'final';
  globalSearch: 'manifest-cursor-v1';
  searchIndex: 'revision-gin-v1';
  boundedDiscussion?: 'typed-draft-v1';
  storyDiscussion?: 'owned-layout-source-v1';
  passages?: 'run-window-v1';
  passageOperations?: 'typed-operations-v1';
  orderedPassages?: 'ordered-window-v1';
  maxPassageCharacters?: number;
  maxDocumentBytes: number;
  maxCommitBytes: number;
}
