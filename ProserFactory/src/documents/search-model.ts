import type {DocumentAnchor,DocumentSpan} from './model';
/** Search never mutates or rebases a target. Navigation must recheck the scene
 * revision before restoring a returned selection in an editing surface. */
export interface DocumentSearchRequest {q:string;caseSensitive?:boolean;limit?:number;cursor?:string}
export interface DocumentSearchHit {
 id:string;sceneId:number;sceneNumber:number;chapterId:number;wordCount:number;sceneRevisionId:string;sceneContentHash:string;projectionSha256:string;
 from:number;to:number;sourceText:string;excerpt:string;excerptFrom:number;excerptTo:number;
 anchors:DocumentAnchor[];locations:DocumentSpan[];editable:boolean;
}
export interface DocumentSearchResponse {
 schemaVersion:1;sourceBookRevisionId:string;sourceContentHash:string;currentBookRevisionId:string;stale:boolean;
 projection:'final';normalization:'unicode-16.0.0-nfc-full-casefold-v1';index:'revision-gin-v1';
 query:string;caseSensitive:boolean;hits:DocumentSearchHit[];scannedScenes:number;decodedBytes:number;
 complete:boolean;nextCursor?:string;
}

export interface DocumentSearchIndexRecoveryRequest {after?:string;limit?:number}
export interface DocumentSearchIndexRecoveryResponse {
 schemaVersion:1;index:'revision-gin-v1';normalization:'unicode-16.0.0-nfc-full-casefold-v1';
 scanned:number;missing:number;inserted:number;verified:number;complete:boolean;nextAfter?:string;
}

/** Book-wide replace previews every match against the current immutable head.
 * Applying commits all selected matches as one book revision; restoring
 * previousRevisionId undoes it while the head is still that revision. */
export interface DocumentReplacePreviewRequest {q:string;replacement:string;caseSensitive?:boolean}
export type DocumentReplaceSkipReason='formatting'|'boundary'|'tracked-change'|'unsupported';
export interface DocumentReplaceMatch {
 id:string;sceneId:number;sceneNumber:number;chapterId:number;sceneRevisionId:string;
 from:number;to:number;sourceText:string;excerpt:string;excerptFrom:number;excerptTo:number;
 replaceable:boolean;reason?:DocumentReplaceSkipReason;
}
export interface DocumentReplacePreviewResponse {
 schemaVersion:1;sourceBookRevisionId:string;query:string;replacement:string;caseSensitive:boolean;
 matches:DocumentReplaceMatch[];sceneCount:number;truncated:boolean;
}
export interface DocumentReplaceApplyRequest {
 schemaVersion:1;operationId:string;expectedRevisionId:string;q:string;replacement:string;caseSensitive?:boolean;
 matches:Array<{sceneId:number;sceneRevisionId:string;from:number;to:number}>;
}
export interface DocumentReplaceApplyReceipt {
 kind:'replace';operationId:string;revisionId:string;previousRevisionId:string;contentHash:string;
 replacedCount:number;scenes:Array<{sceneId:number;revisionId:string;contentHash:string;wordCount:number}>;status:'completed';
}
