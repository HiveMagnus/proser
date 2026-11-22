import {manuscriptRevisionService} from '@/services/manuscriptRevisionService';
import {styleFingerprint} from './detectors/coreDetectors';
/** Result evidence belongs to the immutable result revision, even when newer
 * manual work is committed before the workflow records its metrics. */
export async function revisionStyleFingerprints(bookId:number,revisionId:string,sceneIds:number[]){
 const snapshot=await manuscriptRevisionService.snapshotRevision(bookId,revisionId);
 const scenes=new Map(snapshot.scenes.map((scene)=>[scene.id,scene]));
 return [...new Set(sceneIds)].map((sceneId)=>{const scene=scenes.get(sceneId);if(!scene)throw new Error('EDITORIAL_RESULT_SCOPE_INVALID');return {sceneId,fingerprint:styleFingerprint(scene.prose)};});
}
