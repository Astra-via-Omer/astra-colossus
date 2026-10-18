import test from 'node:test';
import assert from 'node:assert/strict';
import { hasActiveEntitlement } from '../src/entitlement.mjs';

const now=Date.parse('2026-10-18T10:00:00.000Z');
const active={version:1,kind:'trial',enabled:true,expiresAt:'2026-10-18T10:00:00.001Z'};
test('trial and subscription expiry share a strict boundary and deny missing or malformed plans',()=>{
 for(const kind of ['trial','subscription']) {
  assert.equal(hasActiveEntitlement({astra_entitlement:{...active,kind}},now),true);
  assert.equal(hasActiveEntitlement({astra_entitlement:{...active,kind,expiresAt:'2026-10-18T10:00:00.000Z'}},now),false);
 }
 for(const value of [null,{},[],{...active,version:2},{...active,enabled:'true'},{...active,enabled:false},{...active,kind:'permanent'},{...active,expiresAt:'not-a-date'},{...active,expiresAt:'2026-02-30T10:00:00.000Z'},{...active,expiresAt:null}]) assert.equal(hasActiveEntitlement({astra_entitlement:value},now),false);
 assert.equal(hasActiveEntitlement(undefined,now),false);
 assert.equal(hasActiveEntitlement({role:'admin'},now),false,'An admin role never grants a term');
 assert.equal(hasActiveEntitlement({user_metadata:{astra_entitlement:active}},now),false,'Editable metadata never grants a term');
});

import {configuration} from '../src/config.mjs';
import {createService} from '../src/server.mjs';
test('model work is cancelled when the plan deadline passes during a request',async t=>{
 const config=configuration({COLOSSUS_REQUIRE_GROUPS:'false',ASTRA_PROVIDER_CONFIG_JSON:'{"key":"provider-test","model":"test"}',SUPABASE_URL:'https://auth.invalid',SUPABASE_ANON_KEY:'public',SUPABASE_SERVICE_ROLE_KEY:'private'});
 const expiresAt=new Date(Date.now()+1000).toISOString();let entered=false;
 const service=createService(config,{logger:()=>{},fetcher:async(url,options)=>{
  if(url.endsWith('/auth/v1/user'))return Response.json({id:'11111111-1111-4111-8111-111111111111',app_metadata:{role:'admin',astra_entitlement:{version:1,kind:'trial',enabled:true,expiresAt}}});
  if(url.endsWith('/rpc/astra_admit_model_request')){const args=JSON.parse(options.body);return Response.json({id:args.p_computation||args.p_request,owned:!args.p_computation});}
  if(url.endsWith('/rpc/astra_finish_model_request'))return Response.json(null);
  entered=true;return new Promise((resolve,reject)=>{if(options.signal.aborted)reject(Error('aborted'));else options.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});
 }});
 await new Promise(resolve=>service.server.listen(0,'127.0.0.1',resolve));t.after(()=>{service.server.closeAllConnections();service.server.close();});
 const response=await fetch('http://127.0.0.1:'+service.server.address().port+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer same-token','Content-Type':'application/json'},body:JSON.stringify({messages:[{role:'user',content:'hello'}]})});
 assert.equal(entered,true);assert.equal(response.status,403);assert.equal((await response.json()).error.code,'entitlement_inactive');
});
