import 'dotenv/config';
import { databaseService } from '../src/lib/database';
import redis from '../src/lib/redis';
import { previewLegacyHtmlScene, commitLegacyHtmlScene } from '../src/documents/legacyHtmlBackfill';
async function main(){
 const args=process.argv.slice(2); const value=(name:string)=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
 const userId=Number(value('--user-id'));const bookId=Number(value('--book-id'));
 if(!Number.isSafeInteger(userId)||userId<1||!Number.isSafeInteger(bookId)||bookId<1)throw new Error('Required --user-id and --book-id.');
 await databaseService.connect();
 if(args.includes('--apply')){
   const previewId=value('--preview-id');const operationId=value('--operation-id');const expectedRevisionId=value('--expected-book-revision');const consentReportHash=value('--consent-report');
   if(!previewId||!operationId||!expectedRevisionId||!consentReportHash)throw new Error('Apply requires exact --preview-id, --operation-id, --expected-book-revision and --consent-report.');
   process.stdout.write(JSON.stringify(await commitLegacyHtmlScene(userId,bookId,previewId,{operationId,expectedRevisionId,consentReportHash}))+'\n');
 }else{const sceneId=Number(value('--scene-id'));if(!Number.isSafeInteger(sceneId)||sceneId<1)throw new Error('Preview requires --scene-id.');process.stdout.write(JSON.stringify(await previewLegacyHtmlScene(userId,bookId,sceneId))+'\n');}
}
main().catch((error:unknown)=>{process.stderr.write((error instanceof Error?error.message:'Legacy HTML conversion failed.')+'\n');process.exitCode=1;}).finally(async()=>{try{await databaseService.disconnect();}finally{redis.disconnect();}});
