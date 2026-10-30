import test from 'node:test';
import assert from 'node:assert/strict';
import {AccountEventOutbox} from '../src/accountEventOutbox.mjs';
import {ControlStore} from '../src/controlStore.mjs';
const owner='00000000-0000-4000-8000-000000000001',requestId='00000000-0000-4000-8000-000000000002';
test('Colossus queues minimal intent before its usage checkpoint, retries missing commits and accepts idempotently',async()=>{
  const store=new ControlStore({},fetch),monitor={bucket:'test',cloud:{auth:async()=>'cloud-token'},name:()=>`usage/v1/2026-10-30/0000000000000-${requestId}/started.json`};
  const config={accountEvents:true,eventPublishKey:'1'.repeat(64),supabaseUrl:'https://accounts.example',anonKey:'anon'};
  const record={actor:{kind:'account',id:owner,email:'private@example.test'},requestId,startedAt:new Date().toISOString(),calls:[{prompt:'private source'}],status:'running'};
  let committed=false,published=0;
  const queue=new AccountEventOutbox(store,monitor,config,async(url,options)=>{
    if(String(url).startsWith('https://storage.googleapis.com/'))return committed?Response.json(record):new Response('',{status:404});
    assert.equal(String(url),'https://accounts.example/rest/v1/rpc/astra_events_publish');const body=JSON.parse(options.body);assert.equal(body.p_owner,owner);assert.equal(body.p_product,'colossus');assert(!options.body.includes('private source'));assert(!options.body.includes('private@example'));published++;return Response.json(requestId);
  });
  await queue.prepare(record,'started');await queue.prepare(record,'started');
  const rows=await store.pendingAccountEvents();assert.equal(rows.length,1);assert(!JSON.stringify(rows).includes('private'));
  assert.equal((await queue.dispatch()).sent,0);assert.equal(published,0);
  committed=true;assert.equal((await queue.dispatch()).sent,1);assert.equal((await queue.dispatch()).sent,0);assert.equal(published,1);
});
