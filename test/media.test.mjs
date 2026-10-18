import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaObserver,validateMedia,validateObservation,mediaUsage } from '../src/media.mjs';
import {configuration} from '../src/config.mjs';
import {createService} from '../src/server.mjs';
function sample(){const b=Buffer.alloc(44+32000);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return {durationMs:1000,audio:{mimeType:'audio/wav',data:b.toString('base64')},frames:[{mimeType:'image/jpeg',data:Buffer.from([255,216,255,217]).toString('base64'),offsetMs:0}]};}
const observation={transcript:'Traffic fell by 20 percent.',visualSummary:'A chart is shown.',onScreenText:'Vessel traffic',topic:'Vessel traffic',claims:[{text:'Traffic fell by 20 percent.',quote:'Traffic fell by 20 percent.',modality:'speech',offsetMs:100}],links:[]};
test('media admission rejects URLs, oversized/invalid WAV, timestamps and invented source quotes',()=>{
 assert.equal(validateMedia(sample()).durationMs,1000);
 for(const input of [{...sample(),durationMs:5000},{...sample(),audio:{mimeType:'audio/wav',data:'https://private.invalid/a.wav'}},{...sample(),durationMs:2000},{...sample(),frames:[{...sample().frames[0],offsetMs:1001}]}])assert.throws(()=>validateMedia(input));
 assert.throws(()=>validateObservation({...observation,claims:[{...observation.claims[0],quote:'Traffic rose.'}]},1000));
 const valid=validateObservation(observation,1000);assert.equal(valid.claims[0].evidenceStatus,'unverified');assert.equal('score' in valid.claims[0],false);
});
test('cross-channel connections require exact recognized quotations from both observed sources',()=>{
 const r={id:'11111111-1111-4111-8111-111111111111:0',feed:'dw',transcript:'Traffic fell by one fifth.',onScreenText:'',visualSummary:''};
 const link={referenceId:r.id,relation:'same-topic',topic:'Traffic',quote:'20 percent',referenceQuote:'one fifth',reason:'Both reports discuss traffic decline.'};
 assert.equal(validateObservation({...observation,links:[link]},1000,[r]).links.length,1);
 assert.throws(()=>validateObservation({...observation,links:[{...link,referenceQuote:'half'}]},1000,[r]));
 assert.throws(()=>validateObservation({...observation,links:[link]},1000,[]));
});
test('native Vertex uses runtime identity, preflights token budget, normalizes billable thinking and strips output extras',async()=>{
 const calls=[];
 const client=new MediaObserver({project:'astra-via',location:'global',model:'gemini-3.1-flash-lite'},async(url,options)=>{
  calls.push({url:String(url),options});
  if(String(url).startsWith('http://metadata.'))return Response.json({access_token:'synthetic-runtime-token',expires_in:3600});
  if(String(url).endsWith(':countTokens'))return Response.json({totalTokens:500});
  return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({...observation,secret:'discard'})}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:30,thoughtsTokenCount:5,totalTokenCount:135,promptTokensDetails:[{modality:'AUDIO',tokenCount:100}]}});
 });
 const result=await client.observe(sample(),AbortSignal.timeout(1000));
 assert.equal(result.observation.transcript,observation.transcript);assert.equal(result.observation.secret,undefined);
 assert.equal(result.usage.completion_tokens,35);assert.equal(result.usage.complete,true);
 assert.equal(calls.length,3);const request=JSON.parse(calls[1].options.body);assert.equal(request.generateContentRequest,undefined);assert.ok(request.contents[0].parts.some(p=>p.inlineData?.mimeType==='audio/wav'));
 assert.equal(calls[2].options.headers.Authorization,'Bearer synthetic-runtime-token');
 assert.equal(calls[2].options.redirect,'error');
});
test('over-budget inputs stop before generation; rejected model content retains measured usage',async()=>{
 let generated=0;
 const mock=(tokens,good=false)=>async(url)=>String(url).startsWith('http://metadata.')?Response.json({access_token:'test',expires_in:3600}):String(url).endsWith(':countTokens')?Response.json({totalTokens:tokens}):(generated++,Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({...observation,claims:[{...observation.claims[0],quote:'invented'}]})}]}}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:5,totalTokenCount:15}}));
 const c={project:'astra-via',location:'global',model:'gemini-3.1-flash-lite'};
 const rejected=await new MediaObserver(c,mock(6001)).observe(sample(),new AbortController().signal);assert.equal(rejected.observation,null);assert.equal(rejected.usage.total_tokens,0);assert.equal(rejected.usage.complete,true);assert.equal(generated,0);
 const result=await new MediaObserver(c,mock(500)).observe(sample(),new AbortController().signal);assert.equal(result.observation,null);assert.equal(result.usage.total_tokens,15);
 assert.equal(mediaUsage({promptTokenCount:10,totalTokenCount:15}).complete,false);
});
test('media HTTP route authenticates before inference and exposes configured capability without credentials',async t=>{
 const config=configuration({COLOSSUS_REQUIRE_GROUPS:'false',ASTRA_PROVIDER_CONFIG_JSON:JSON.stringify({key:'synthetic-key',model:'test-model'}),COLOSSUS_MEDIA_PROJECT:'astra-via',COLOSSUS_MEDIA_MODEL:'gemini-3.1-flash-lite'});
 let calls=0;const service=createService(config,{fetcher:async()=>{calls++;throw Error('unexpected');},logger:()=>{}});
 await new Promise(r=>service.server.listen(0,'127.0.0.1',r));t.after(()=>{service.server.closeAllConnections();service.server.close();});
 const url='http://127.0.0.1:'+service.server.address().port;
 assert.equal((await fetch(url+'/v1/media/observe',{method:'POST',headers:{'Content-Type':'application/json',Origin:config.origin},body:JSON.stringify(sample())})).status,401);
 const r=await fetch(url+'/v1/capabilities',{headers:{Authorization:'Bearer synthetic-key'}});const d=await r.json();assert.equal(d.observer.status,'ready');assert.equal(JSON.stringify(d).includes('synthetic-key'),false);assert.equal(calls,0);
});
test('account media calls require the Enigma server credential as well as the protected analyst identity',async t=>{
 const gatewayKey='synthetic-enigma-gateway-credential-00000001';let role='participant',providerCalls=0;
 const config=configuration({COLOSSUS_REQUIRE_GROUPS:'false',ASTRA_PROVIDER_CONFIG_JSON:JSON.stringify({key:'synthetic-key',model:'test-model'}),SUPABASE_URL:'https://accounts.example.invalid',SUPABASE_ANON_KEY:'synthetic-public',SUPABASE_SERVICE_ROLE_KEY:'credit-server-key',COLOSSUS_MEDIA_PROJECT:'astra-via',COLOSSUS_MEDIA_MODEL:'gemini-3.1-flash-lite',COLOSSUS_MEDIA_INGEST_KEY:gatewayKey});
 const service=createService(config,{logger:()=>{},fetcher:async (url,options)=>{
  if(String(url).includes('/rpc/astra_admit_model_request')){const args=JSON.parse(options.body);return Response.json({id:args.p_computation||args.p_request,owned:!args.p_computation});}
  if(String(url).includes('/rpc/astra_finish_model_request'))return Response.json(null);
  if(String(url).includes('/auth/v1/user'))return Response.json({id:'11111111-1111-4111-8111-111111111111',app_metadata:{astra_entitlement: {version:1,kind:'subscription',enabled:true,expiresAt:'2099-12-31T00:00:00.000Z'}, role}});
  if(String(url).startsWith('http://metadata.'))return Response.json({access_token:'synthetic-runtime',expires_in:3600});
  providerCalls++;return Response.json({totalTokens:6001});
 }});
 await new Promise(r=>service.server.listen(0,'127.0.0.1',r));t.after(()=>{service.server.closeAllConnections();service.server.close();});
 const base='http://127.0.0.1:'+service.server.address().port;
 const call=key=>fetch(base+'/v1/media/observe',{method:'POST',headers:{Authorization:'Bearer synthetic-user-session','Content-Type':'application/json',...(key?{'X-Enigma-Media-Key':key}:{})},body:JSON.stringify(sample())});
 assert.equal((await call()).status,403);assert.equal((await call('wrong-key')).status,403);assert.equal(providerCalls,0);
 const valid=await call(gatewayKey);assert.equal(valid.status,200);assert.equal((await valid.json()).usage.total_tokens,0);assert.equal(providerCalls,1);
 role='viewer';assert.equal((await call(gatewayKey)).status,403);assert.equal(providerCalls,1);
});

test('native media retains system grants, paused routes and atomic spending admission before generation',async t=>{
 const config=configuration({COLOSSUS_REQUIRE_GROUPS:'false',SUPABASE_URL:'https://accounts.example.invalid',SUPABASE_ANON_KEY:'public',SUPABASE_SERVICE_ROLE_KEY:'credits',COLOSSUS_MEDIA_INGEST_KEY:'synthetic-media-gateway-credential-00000001',ASTRA_PROVIDER_CONFIG_JSON:JSON.stringify({key:'synthetic-key',model:'test-model'}),COLOSSUS_MEDIA_PROJECT:'astra-via',COLOSSUS_MEDIA_MODEL:'gemini-3.1-flash-lite'});
 let generated=0;
 const app=createService(config,{logger:()=>{},fetcher:async (url,options)=>{
  if(String(url).includes('/auth/v1/user'))return Response.json({id:'11111111-1111-4111-8111-111111111111',app_metadata:{astra_entitlement: {version:1,kind:'subscription',enabled:true,expiresAt:'2099-12-31T00:00:00.000Z'}, role:'participant'}});
  if(String(url).includes('/rpc/astra_admit_model_request')){const args=JSON.parse(options.body);return Response.json({id:args.p_computation||args.p_request,owned:!args.p_computation});}
  if(String(url).startsWith('http://metadata.'))return Response.json({access_token:'synthetic-runtime',expires_in:3600});
  if(String(url).endsWith(':countTokens'))return Response.json({totalTokens:500});
  generated++;return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(observation)}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:30,thoughtsTokenCount:5,totalTokenCount:135,promptTokensDetails:[{modality:'AUDIO',tokenCount:100}]}});
 }});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>{app.server.closeAllConnections();app.server.close();});
 const actor={id:'admin',email:'admin@example.com'},base='http://127.0.0.1:'+app.server.address().port;
 const call=key=>fetch(base+'/v1/media/observe',{method:'POST',headers:{Authorization:'Bearer account-token','X-Colossus-Service-Key':key,'X-Astra-Computation-Id':'33333333-3333-4333-8333-333333333333','X-Enigma-Media-Key':'synthetic-media-gateway-credential-00000001','Content-Type':'application/json'},body:JSON.stringify(sample())});
 const denied=await app.control.issueKey({name:'Text only',systemId:'enigma',requireGroup:false,allowedModels:['astra-default']},actor);
 assert.equal((await call(denied.oneTimeKey)).status,403);assert.equal(generated,0);
 const granted=await app.control.issueKey({name:'Media backend',systemId:'enigma',requireGroup:false,allowedModels:['broadcast-media']},actor);
 await app.control.save('systems',{id:'enigma',name:'Enigma',monthlyBudgetUsd:0.0001},actor);
 assert.equal((await call(granted.oneTimeKey)).status,402);assert.equal(generated,0);
 await app.control.save('systems',{id:'enigma',name:'Enigma',monthlyBudgetUsd:0.01},actor);
 assert.equal((await call(granted.oneTimeKey)).status,200);assert.equal(generated,1);
 const snapshot=await app.control.snapshot(),wallet=snapshot.systems.find(system=>system.id==='enigma').spending;
 assert.equal(wallet.reservedUsd,0);assert.equal(wallet.tokens,135);assert(Math.abs(wallet.spentUsd-0.0001845)<1e-10);
 assert.equal(snapshot.providers.find(provider=>provider.native).credentialSource,'runtime');
 await app.control.save('providers',{id:'managed-vertex-media',name:'Google Vertex AI',enabled:false},actor);
 assert.equal((await call(granted.oneTimeKey)).status,503);assert.equal(generated,1);
 await assert.rejects(app.control.save('models',{id:'broadcast-media',name:'Native',model:'another-model'},actor),{code:'native_configuration'});
});
