import type { DocumentStyleDefinitions } from './style-model';
/** Factory-owned public publication/import contracts, generated into Author. */
import type { ProserDocument } from './model';
export type DocumentPublicationFormat =
  'docx' | 'epub' | 'pdf' | 'html' | 'markdown' | 'text' | 'json';
export type DocumentPublicationMode = 'retain-review' | 'final' | 'original';
export type DocumentPublicationPreset = 'saved' | 'submission-manuscript' | 'print-book';
export interface DocumentPublicationOptions {
  format: DocumentPublicationFormat;
  mode: DocumentPublicationMode;
  preset: DocumentPublicationPreset;
}
export interface DocumentPublicationCapabilities {
  schemaVersion: 1;
  modes: string[];
  presets: string[];
  formats: Array<{
    format: string;
    mediaType: string;
    extension: string;
    available: boolean;
    reason: string | null;
    review: string;
  }>;
  nativeCommentRanges?: {maximum:number;contiguousOnly:boolean;headerFooterSupported:boolean;scope:string};
  codecVersion: string;
  rendererVersion: string;
  wordAcceptance: string;
}
export interface DocumentPublicationFidelity { losses: string[]; fontSubstitutions: Array<{ requested: string; actual: string }>; wordAcceptance: string }
export interface DocumentPublicationJob {
  id: string;
  sourceRevisionId: string;
  sourceHash: string;
  status: string;
  options: DocumentPublicationOptions;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  artifactId: string | null;
  downloadPath: string | null;
  reviewSidecarPath: string | null;
  fidelity?: DocumentPublicationFidelity;
}
export interface DocumentPublicationRequest {
  operationId: string;
  expectedRevisionId: string;
  options: DocumentPublicationOptions;
}
export interface DocumentImportLoss {
  code: string;
  count: number;
  message: string;
}
export interface DocumentDocxImportReport {
  schemaVersion: 1;
  format: 'docx';
  codecVersion: string;
  originalId: string;
  originalSha256: string;
  convertedSha256: string;
  strategy: string;
  chapterCount: number;
  wordCount: number;
  detected: Array<{ feature: string; count: number }>;
  losses: DocumentImportLoss[];
  externalResourcesFetched: false;
  nativeParagraphRevisionAcceptance: string;
  mapping: Array<{ chapterIndex: number; title: string; sceneCount: number }>;
}
export interface DocumentDocxImportPreview {
  id: string;
  originalId: string;
  sourceBookRevisionId: string;
  reportHash: string;
  report: DocumentDocxImportReport;
  mapping: Array<{ chapterIndex: number; title: string; sceneCount: number }>;
  styles?:DocumentStyleDefinitions;
  documents: ProserDocument[];
  headerFooterStories?: Array<{documentIndex:number;kind:'header'|'footer';document:ProserDocument}>;
}
/** Markdown and plain-text manuscripts preserved byte for byte and converted
 * through the append-import pipeline (`POST import-originals/:id?format=`). */
export type DocumentTextImportFormat = 'markdown' | 'plain-text';
export interface DocumentTextImportReport {
  schemaVersion: 1;
  codec: 'proser-plain-manuscript';
  codecVersion: string;
  format: DocumentTextImportFormat;
  originalId: string;
  originalSha256: string;
  sourceBookRevisionId: string;
  strategy: 'append-new-identities';
  convertedSha256: string;
  title: string;
  byline: string | null;
  actCount: number;
  chapterCount: number;
  sceneCount: number;
  wordCount: number;
  codexCount: 0;
  encoding: 'utf-8' | 'windows-1252';
  paragraphMode: 'blank-line' | 'line';
  fileNames: string[];
  losses: Array<{ code: string; message: string; count?: number }>;
}
export interface DocumentTextImportPreview {
  id: string;
  originalId: string;
  sourceBookRevisionId: string;
  reportHash: string;
  report: DocumentTextImportReport;
  mapping: {
    acts: Array<{
      title?: string;
      chapters: Array<{ title?: string; summary?: string; scenes: Array<{ summary?: string }> }>;
    }>;
  };
}
export interface DocumentTextImportCommitRequest {
  operationId: string;
  expectedRevisionId: string;
  expectedScopes: { structure: string; canon: string };
  consentReportHash: string;
}
export interface DocumentDocxImportCommitRequest {
  operationId: string;
  expectedRevisionId: string;
  expectedScopes: { structure: string; canon: string; layout: string };
  consentReportHash: string;
}
