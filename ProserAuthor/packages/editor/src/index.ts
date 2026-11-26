// @hivemagnus/proser-editor — owned Canvas and semantic document surfaces

export { CanvasDocumentEditor } from './components/canvas-document-editor';
export { SemanticDocument } from './components/semantic-document';
export { documentToCanvas, canvasToDocument } from './canvas-adapter';
export {
  canvasSelection,
  paragraphSelection,
  restoreCanvasSelection,
  type DocumentSelection,
} from './document-selection';
export * from './document-model';
export { formatDocumentSelection, formatDocumentParagraph } from './semantic-operations';

export { moveDocumentBlocks } from './window-operations';

export {
  splitDocumentSceneBoundary,
  joinDocumentSceneBoundary,
  movedBlockLineage,
  reverseAnchorLineage,
} from './scene-boundary-operations';
