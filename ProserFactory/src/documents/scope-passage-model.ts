import type { DocumentAnchorLineage, SceneDocumentReference } from './model';
import type { DocumentPassage, DocumentPassageRequest, DocumentPassageSourceFrame } from './passage-model';
import type { PassageParagraphSource, PassageRunSource } from './passage-operations-model';
export interface PassageScopeSource {
  sceneId:number; expectedSceneRevisionId:string; sourceFrame:DocumentPassageSourceFrame;
  windowHash:string; window:DocumentPassageRequest;
}
export type PassageScopeTransfer = {
  schemaVersion:1;operationId:string;expectedRevisionId:string;source:PassageScopeSource;destination:PassageScopeSource;
} & (
  | {kind:'move-blocks';blocks:Array<{blockId:string;sourceHash:string}>;placement:'start'|'end'}
  | {kind:'split-scene';target:PassageRunSource;expectedText:string}
  | {kind:'join-scenes';left:PassageParagraphSource;right:PassageParagraphSource;boundaryHash:string;tracking?:boolean}
);
export interface PassageScopeRestore {
 schemaVersion:1;operationId:string;expectedRevisionId:string;restoreFromBookRevisionId:string;
 scenes:PassageScopeSource[];
}
export interface PassageScopeResult {
 passages:DocumentPassage[];sourceBookRevisionId:string;sceneIds:number[];
 anchorLineage?:DocumentAnchorLineage[];
 restoredFromBookRevisionId?:string;
}
export interface PassageScopeReceipt {
 kind:'catalog';operationId:string;revisionId:string;contentHash:string;status:'completed';
 sceneReferences:SceneDocumentReference[];result:PassageScopeResult;
}
