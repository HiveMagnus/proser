/** Explicit create-only derived backfill; source evidence and heads stay intact. */
import 'dotenv/config';
import {databaseService} from '../src/lib/database';
import redis from '../src/lib/redis';
import {documentService} from '../src/documents/service';
import {backfillSceneSearchIndexes} from '../src/documents/searchIndex';
async function main(){
 const value=(name:string)=>{const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];};
 const userId=Number(value('--user-id'));const bookId=Number(value('--book-id'));if(!Number.isSafeInteger(userId)||userId<=0||!Number.isSafeInteger(bookId)||bookId<=0)throw new Error('Explicit --user-id and --book-id are required.');
 await databaseService.connect();await documentService.manifest(userId,bookId);
 const result=await databaseService.client.$transaction((tx)=>backfillSceneSearchIndexes(tx,bookId,{after:value('--after'),limit:8,apply:process.argv.includes('--apply')}),{timeout:30000});process.stdout.write(JSON.stringify(result)+'\n');
}
main().catch(()=>{process.stderr.write('Search index backfill failed. Preserve original evidence and inspect the private error record.\n');process.exitCode=1;}).finally(async()=>{try{await databaseService.disconnect();}finally{redis.disconnect();}});
