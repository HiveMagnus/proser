/** Synthetic tests temporarily install candidate triggers. Restore prior
 * definitions/modes exactly; never alter production enforcement. */
import { Client } from 'pg';
interface TriggerState {schema:string;table:string;name:string;definition:string;enabled:'O'|'D'|'R'|'A'}
export interface EnforcementTestState {triggers:TriggerState[];enabled?:boolean}
function client():Client {
 const url=process.env.DATABASE_URL??'';
 if(!/^postgres(?:ql)?:\/\/[^/]+@127\.0\.0\.1:55441\/proser_canvas_[a-zA-Z0-9_]+(?:\?.*)?$/.test(url))throw new Error('Enforcement fixture restoration requires explicit synthetic PostgreSQL.');
 return new Client({connectionString:url});
}
const quote=(value:string)=>'"'+value.replace(/"/g,'""')+'"';
async function triggers(connection:Client):Promise<TriggerState[]> {
 return (await connection.query<TriggerState>(`SELECT n.nspname AS schema,c.relname AS table,t.tgname AS name,pg_get_triggerdef(t.oid,true) AS definition,t.tgenabled AS enabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname='public' AND (starts_with(t.tgname,'proser_document_') OR starts_with(t.tgname,'proser_release_')) ORDER BY n.nspname,c.relname,t.tgname`)).rows;
}
export async function captureEnforcementTestState():Promise<EnforcementTestState>{
 const connection=client();await connection.connect();try{
  const state:EnforcementTestState={triggers:await triggers(connection)};
  if((await connection.query(`SELECT to_regclass('public.proser_document_enforcement') AS name`)).rows[0]?.name)state.enabled=(await connection.query('SELECT enabled FROM proser_document_enforcement')).rows[0]?.enabled;
  return state;
 }finally{await connection.end();}
}
export async function restoreEnforcementTestState(state:EnforcementTestState):Promise<void>{
 const connection=client();await connection.connect();try{
  await connection.query('BEGIN');
  for(const trigger of await triggers(connection))await connection.query(`DROP TRIGGER ${quote(trigger.name)} ON ${quote(trigger.schema)}.${quote(trigger.table)}`);
  for(const trigger of state.triggers){
   await connection.query(trigger.definition);
   const mode={O:'ENABLE',D:'DISABLE',R:'ENABLE REPLICA',A:'ENABLE ALWAYS'}[trigger.enabled];
   await connection.query(`ALTER TABLE ${quote(trigger.schema)}.${quote(trigger.table)} ${mode} TRIGGER ${quote(trigger.name)}`);
  }
  await connection.query('UPDATE proser_document_enforcement SET enabled=$1',[state.enabled??false]);
  await connection.query('COMMIT');
  if(JSON.stringify(await triggers(connection))!==JSON.stringify(state.triggers))throw new Error('Synthetic enforcement trigger state was not restored exactly.');
 }catch(error){await connection.query('ROLLBACK');throw error;}finally{await connection.end();}
}
