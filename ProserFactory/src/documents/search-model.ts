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
