import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { z } from 'zod';
import { requiredStr, requiredInt } from '@/api/schemas/shared';

describe('patched dependency security boundaries', () => {
  it('rejects an oversized constrained collection before validating its elements', () => {
    let visited = 0;
    const schema = z.array(z.unknown().superRefine(() => { visited++; })).max(16);
    const result = schema.safeParse(Array(50_000).fill({ invalid: true }));
    expect(result.success).toBe(false);
    expect(visited).toBe(0);
    if (!result.success) expect(result.error.issues).toHaveLength(1);
  });

  it('retains required versus invalid field messages through the Zod migration', () => {
    const text = requiredStr('title');
    const number = requiredInt('bookId');
    expect(text.safeParse(undefined).error?.issues[0].message).toBe('title is required');
    expect(text.safeParse(42).error?.issues[0].message).toBe('title must be a string');
    expect(number.safeParse(undefined).error?.issues[0].message).toBe('bookId is required');
    expect(number.safeParse('42').error?.issues[0].message).toBe('bookId must be a valid integer');
  });

  it('survives a compressed JSON body with trailing invalid bytes in a separate process', () => {
    const output = execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const express = require('express');
      const http = require('node:http');
      const {gzipSync}=require('node:zlib');
      const app=express();app.use(express.json({limit:'32kb'}));
      app.post('/body',(_req,res)=>res.json({ok:true}));
      app.get('/health',(_req,res)=>res.json({ok:true}));
      app.use((error,req,res,next)=>res.status(400).json({error:'invalid body'}));
      const server=app.listen(0,'127.0.0.1',async()=>{
        try {
          const port=server.address().port;
          const payload=Buffer.concat([gzipSync(Buffer.from('{"ok":true}')),Buffer.from('invalid trailing frame')]);
          const status=await new Promise((resolve,reject)=>{
            const req=http.request({hostname:'127.0.0.1',port,path:'/body',method:'POST',headers:{'content-type':'application/json','content-encoding':'gzip','content-length':payload.length}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
            req.on('error',reject);req.end(payload);
          });
          assert.ok([200,400].includes(status));
          await new Promise(resolve=>setImmediate(resolve));
          const health=await fetch('http://127.0.0.1:'+port+'/health');
          assert.equal(health.status,200);assert.deepEqual(await health.json(),{ok:true});
          console.log('process survived');
        }catch(error){console.error(error);process.exitCode=1;}
        finally{server.close();}
      });
    `], {cwd:path.resolve(__dirname, '../..'),encoding:'utf8',timeout:15_000});
    expect(output).toContain('process survived');
  });
});
