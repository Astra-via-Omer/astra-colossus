import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Credits } from '../src/credits.mjs';
import { configuration } from '../src/config.mjs';
import { createService } from '../src/server.mjs';

const identity = {kind:'account',id:'11111111-1111-4111-8111-111111111111',systemId:'workflow'};
test('all account inference fails closed on rejected, unavailable or malformed credit verification',async t=>{
 const failures = [
  [Response.json({message:'CLIENT_INSUFFICIENT_CREDITS'},{status:400}),402],
  [Response.json({message:'CLIENT_PAUSED'},{status:400}),403],
  [Response.json({message:'CLIENT_RESERVATION_REQUIRED'},{status:400}),409],
  [Response.json({message:'CLIENT_ACCOUNT_REQUIRED'},{status:400}),409],
  [Response.json({code:'PGRST202'},{status:404}),503],
  [Response.json({id:'invalid',owned:false}),503],
 ];
 for (const [response,status] of failures) {
  const credits = new Credits({supabaseUrl:'https://auth.invalid',serviceKey:'private-server-key'},async()=>response.clone());
  await assert.rejects(credits.admit(identity,randomUUID(),randomUUID()),error=>error.status===status);
 }
 const missing = new Credits({},()=>{throw Error('Should not call');});
 await assert.rejects(missing.admit(identity,randomUUID(),randomUUID()),error=>error.status===503);
 for (const systemId of ['workflow','enigma','lab']) await assert.rejects(missing.admit({kind:'service',systemId},randomUUID()),error=>error.code==='account_required');
 await assert.rejects(missing.admit(identity,randomUUID(),'forged'),error=>error.status===409);
});

async function start(t) {
 const state={deny:'CLIENT_INSUFFICIENT_CREDITS',providerCalls:0,checks:0,settlements:[],requestIds:[]};
 const config=configuration({COLOSSUS_REQUIRE_GROUPS:'false',ASTRA_PROVIDER_CONFIG_JSON:'{"key":"synthetic-provider-key","model":"synthetic"}',
  SUPABASE_URL:'https://auth.invalid',SUPABASE_ANON_KEY:'public',SUPABASE_SERVICE_ROLE_KEY:'private-server-key',COLOSSUS_MEDIA_INGEST_KEY:'synthetic-media-ingestion-key-000000001'});
 const app=createService(config,{logger:()=>{},fetcher:async(url,options)=>{
  if(url.endsWith('/auth/v1/user')) return Response.json({id:identity.id,app_metadata:{role:'admin'}});
  if(url.endsWith('/rpc/astra_admit_model_request')) {
   state.checks++;assert.equal(options.headers.Authorization,'Bearer private-server-key');
   const args=JSON.parse(options.body);state.requestIds.push(args.p_request);
   if(state.deny)return Response.json({message:state.deny},{status:400});
   return Response.json({id:args.p_computation||args.p_request,owned:!args.p_computation});
  }
  if(url.endsWith('/rpc/astra_finish_model_request')) { state.settlements.push(JSON.parse(options.body));return Response.json(null); }
  state.providerCalls++;
  if(state.failProvider)return Response.json({error:'secret provider error'},{status:500});
  assert.equal(options.headers['X-Astra-Computation-Id'],undefined,'Internal reservation IDs never reach providers');
  return Response.json({choices:[{message:{content:'answer'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}});
 }});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{app.server.closeAllConnections();app.server.close();});
 const call=(path,body)=>fetch(`http://127.0.0.1:${app.server.address().port}${path}`,{method:'POST',headers:{Authorization:'Bearer account-token','Content-Type':'application/json','X-Enigma-Media-Key':config.mediaIngestKey},body:JSON.stringify(body)});
 return {app,state,call};
}
test('chat, streaming, embeddings, engines, evaluations and media reject exhausted accounts before provider calls',async t=>{
 const {state,call}=await start(t);
 for (const [path,body] of [
  ['/v1/chat/completions',{messages:[{role:'user',content:'hello'}]}],
  ['/v1/chat/completions',{messages:[{role:'user',content:'hello'}],stream:true}],
  ['/v1/embeddings',{input:'hello'}],['/v1/runs',{}],['/v1/engines/test',{}],['/v1/evaluations',{}],['/v1/media/observe',{}],
 ]) assert.equal((await call(path,body)).status,402,path);
 assert.equal(state.providerCalls,0);assert.equal(state.settlements.length,0);
});
test('gateway-owned requests reserve once, recheck before model calls, and settle successful or failed output',async t=>{
 const {app,state,call}=await start(t);state.deny='';
 const body={messages:[{role:'user',content:'hello'}]};
 assert.equal((await call('/v1/chat/completions',body)).status,200);
 assert.equal(state.checks,2);assert.equal(new Set(state.requestIds).size,1);assert.equal(state.providerCalls,1);
 assert.equal(state.settlements[0].p_status,'completed');assert.equal(state.settlements[0].p_usage.totalTokens,15);
 assert(!JSON.stringify([...app.monitoring.local.values()]).includes('account-token'));
 assert(!JSON.stringify([...app.monitoring.local.values()]).includes('creditAdmission'));
 state.failProvider=true;
 assert.equal((await call('/v1/chat/completions',body)).status,502);
 assert.equal(state.settlements[1].p_status,'failed');
});
