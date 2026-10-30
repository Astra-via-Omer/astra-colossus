import {createHash} from 'node:crypto';
import {eventRpc,boundedEventJson} from './account-events/account-events.mjs';
export class AccountEventOutbox {
  constructor(store,monitor,config,fetcher=fetch){this.store=store;this.monitor=monitor;this.config=config;this.fetch=fetcher;}
  async prepare(record,phase){
    if(!this.config.accountEvents||record.actor?.kind!=='account'||!/^[a-f0-9-]{36}$/i.test(record.actor.id))return;
    const at=record.completedAt||record.startedAt,key=record.requestId+':'+phase;
    const path='accountEventOutbox/'+createHash('sha256').update(key).digest('hex');
    await this.store.mutate([path],([existing])=>[existing||{id:path.split('/')[1],pending:true,owner:record.actor.id,resourceId:record.requestId,
      version:at,eventKey:key,state:phase==='started'?'running':['completed','failed','cancelled','partial'].includes(record.status)?record.status:'failed',
      occurredAt:at,usagePath:this.monitor.name(record,phase),preparedAt:new Date().toISOString()}]);
  }
  async dispatch(){
    if(!this.config.accountEvents||!this.config.eventPublishKey)return {sent:0,pending:false};
    const rows=await this.store.pendingAccountEvents(20);let sent=0;
    for(const row of rows){
      if(!/^usage\/v1\/\d{4}-\d{2}-\d{2}\/\d{13}-[a-f0-9-]{36}\/(started|finished)\.json$/.test(row.usagePath))throw Error('Invalid event checkpoint.');
      const response=await this.fetch(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.monitor.bucket)}/o/${encodeURIComponent(row.usagePath)}?alt=media`,{
        headers:{Authorization:'Bearer '+await this.monitor.cloud.auth()},redirect:'error',cache:'no-store',signal:AbortSignal.timeout(8000)});
      if(response.status===404){
        // An intent whose authoritative write failed never becomes an activity.
        if(Date.parse(row.preparedAt)<Date.now()-3600000)await this.store.mutate(['accountEventOutbox/'+row.id],([current])=>[{...current,pending:false,abandoned:true}]);
        continue;
      }
      if(!response.ok)throw Error('Event checkpoint is unavailable.');
      const record=await boundedEventJson(response,131072);
      if(record.requestId!==row.resourceId||record.actor?.id!==row.owner||record.actor?.kind!=='account')throw Error('Event checkpoint does not match.');
      await eventRpc({url:this.config.supabaseUrl,anonKey:this.config.anonKey,token:this.config.anonKey},'astra_events_publish',{
        p_key:this.config.eventPublishKey,p_owner:row.owner,p_product:'colossus',p_event_key:row.eventKey,p_kind:'process',p_resource_id:row.resourceId,
        p_version:row.version,p_state:row.state,p_occurred_at:row.occurredAt},this.fetch);
      await this.store.mutate(['accountEventOutbox/'+row.id],([current])=>[{...current,pending:false,acceptedAt:new Date().toISOString()}]);sent++;
    }
    return {sent,pending:rows.length===20};
  }
}
