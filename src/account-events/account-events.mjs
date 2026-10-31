// Server-only transport. The product and user token come from the product's
// existing authenticated boundary, never from a browser-supplied owner ID.
export class AccountEventsError extends Error {
  constructor(message, status=503) { super(message); this.status=status; }
}
export async function boundedEventJson(response,limit=131072) {
  const reader=response.body?.getReader(); if(!reader)throw new AccountEventsError('Account updates returned no data.');
  let size=0;const chunks=[];
  try { for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;
    if(size>limit){await reader.cancel();throw new AccountEventsError('Account updates exceeded their size limit.');}chunks.push(value);} }
  finally {reader.releaseLock();}
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch {throw new AccountEventsError('Account updates returned unreadable data.');}
}
export async function eventRpc({url,anonKey,token},name,body,fetcher=fetch) {
  if(!/^astra_events_[a-z_]+$/.test(name))throw new AccountEventsError('Invalid account update request.',400);
  let origin;try {origin=new URL(url);}catch {throw new AccountEventsError('Account updates are not configured.');}
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||!anonKey)
    throw new AccountEventsError('Account updates need the shared HTTPS account connection.');
  if(typeof token!=='string'||!token||token.length>8192||/\s/.test(token))throw new AccountEventsError('Sign in to see your account updates.',401);
  let response;
  try {response=await fetcher(new URL('/rest/v1/rpc/'+name,origin),{method:'POST',redirect:'error',cache:'no-store',
    headers:{apikey:anonKey,Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});}
  catch {throw new AccountEventsError('Account updates are temporarily unavailable. Please retry.');}
  // PostgREST returns no body for the void acknowledgement RPC.
  if(response.status===204&&name==='astra_events_read')return null;
  const data=await boundedEventJson(response);
  if(!response.ok){
    if(response.status===401)throw new AccountEventsError('Sign in again to see your account updates.',401);
    if(response.status===403||data?.code==='42501')throw new AccountEventsError('Your account does not have permission for these updates.',403);
    if(data?.code==='40001')throw new AccountEventsError('Your preferences changed in another window. Refresh and retry.',409);
    if(['PGRST202','PGRST205','42883'].includes(data?.code))throw new AccountEventsError('Account updates are awaiting their database deployment.');
    throw new AccountEventsError('Account updates could not be completed.',response.status===429?429:503);
  }
  return data;
}
export async function accountUpdates(config,input,fetcher=fetch) {
  const product=config.product;
  if(!['workflow','enigma','evidence','lab','colossus'].includes(product))throw new AccountEventsError('Unknown product.',400);
  if(input===undefined){
    const [settings,feed]=await Promise.all([eventRpc(config,'astra_events_settings',{p_product:product},fetcher),
      eventRpc(config,'astra_events_feed',{p_product:product,p_after:0,p_limit:20},fetcher)]);
    return {settings,feed};
  }
  if(!input||typeof input!=='object'||Array.isArray(input))throw new AccountEventsError('Supply account update preferences.',400);
  if(input.action==='preferences'){
    if(Object.keys(input).some(k=>!['action','enabled','useEvidence','revision'].includes(k))||typeof input.enabled!=='boolean'||typeof input.useEvidence!=='boolean'||!Number.isSafeInteger(input.revision)||input.revision<0)
      throw new AccountEventsError('Invalid account update preferences.',400);
    return {settings:await eventRpc(config,'astra_events_preferences',{p_product:product,p_enabled:input.enabled,p_use_evidence:input.useEvidence,p_revision:input.revision},fetcher)};
  }
  if(input.action==='read'){
    if(Object.keys(input).some(k=>!['action','seq'].includes(k))||typeof input.seq!=='string'||!/^\d{1,18}$/.test(input.seq))throw new AccountEventsError('Invalid update cursor.',400);
    await eventRpc(config,'astra_events_read',{p_product:product,p_seq:input.seq},fetcher);return {ok:true};
  }
  throw new AccountEventsError('Unknown account update action.',400);
}
export async function accountUpdateBody(request) {
  if(!request.headers.get('content-type')?.startsWith('application/json'))throw new AccountEventsError('Use application/json.',415);
  return boundedEventJson(request,4096);
}
export const accountUpdateHeaders={'Cache-Control':'private, no-store, max-age=0','Vary':'Authorization, Cookie','Content-Type':'application/json; charset=utf-8'};
