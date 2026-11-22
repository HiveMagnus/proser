import type { CommandModule } from 'yargs';
import { createHash } from 'node:crypto';
import { initDatabase,closeDatabase,getDb } from '../utils/database';
import { resolveCliUser } from '../auth';
import { output } from '../utils/output';
import { readOperatorEffect,cancelOperatorEffect } from '@/documents/operatorEffects';
import { canonicalDocument } from '@/documents/model';
interface OperationArgs {bookId:number;operationId:string;'user-id'?:number;view:string;offset:number;limit:number;cancel:boolean}
export const documentOperationCommand:CommandModule<object,OperationArgs>={
 command:'document:operation <bookId> <operationId>',describe:'Inspect or cancel a retained CLI inference effect; never repeat an unknown provider effect',
 builder:(yargs)=>yargs.positional('bookId',{type:'number',demandOption:true}).positional('operationId',{type:'string',demandOption:true}).option('user-id',{type:'number',describe:'Explicit local operator user ID'}).option('view',{choices:['status','request','result'] as const,default:'status'}).option('offset',{type:'number',default:0}).option('limit',{type:'number',default:16384}).option('cancel',{type:'boolean',default:false}),
 handler:async(argv)=>{
  try{await initDatabase();const {id:userId}=await resolveCliUser(getDb(),argv['user-id']);if(argv.cancel){output.json(await cancelOperatorEffect(userId,argv.bookId,argv.operationId));return;}
   if(!['status','request','result'].includes(argv.view))throw new Error('View must be status, request or result.');
   const {request,result,...status}=await readOperatorEffect(userId,argv.bookId,argv.operationId);if(argv.view==='status'){output.json(status);return;}
   if(!Number.isSafeInteger(argv.offset)||argv.offset<0||!Number.isSafeInteger(argv.limit)||argv.limit<1024||argv.limit>32768)throw new Error('Page offset must be nonnegative and limit 1024..32768.');
   const serialized=canonicalDocument(argv.view==='request'?request:result);output.json({operationId:argv.operationId,view:argv.view,encoding:'json-utf16',offset:argv.offset,total:serialized.length,sha256:createHash('sha256').update(serialized).digest('hex'),content:serialized.slice(argv.offset,argv.offset+argv.limit),nextOffset:argv.offset+argv.limit<serialized.length?argv.offset+argv.limit:null});
  }catch(error){output.json({success:false,error:error instanceof Error?error.message:'Operation recovery failed.'});process.exitCode=1;}finally{await closeDatabase();}
 },
};
