const products={workflow:['Workspace','https://workspace.astra-via.com/'],enigma:['Enigma','https://enigma.astra-via.com/'],
  evidence:['Evidence','https://evidence-validation.astra-via.com/'],lab:['Lab','https://lab.astra-via.com/lab'],colossus:['Colossus','https://colossus.astra-via.com/app']};
const kinds={source:'source',review:'review',case:'case',process:'process',model:'model release'};
const states={queued:'queued',running:'in progress',completed:'ready',partial:'partly complete',failed:'needs attention',cancelled:'cancelled'};
const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text)e.textContent=text;if(cls)e.className=cls;return e;};
export function mountAccountUpdates(host,{endpoint='/api/account-events',token,onUse}={}) {
  let closed=false,busy=false,settings,feed,controller;
  if(!document.getElementById('astra-account-updates-css')){const style=document.createElement('link');style.id='astra-account-updates-css';style.rel='stylesheet';style.href='/account-updates.css';document.head.append(style);}
  host.classList.add('astra-account-updates');
  const details=node('details'),summary=node('summary','Account updates'),content=node('section',null,'aau-content'),message=node('p','Connecting your account updates…','aau-note');
  details.append(summary,content);host.replaceChildren(details);content.append(message);
  async function request(body){
    const response=await fetch(endpoint,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',signal:controller?.signal,
      headers:{...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    if(response.status===401||response.status===403){settings=undefined;feed=undefined;host.replaceChildren();throw new Error('Account access changed. Sign in again.');}
    const data=await response.json();if(!response.ok)throw new Error(data.error?.message||data.error||'Account updates are unavailable.');return data;
  }
  async function change(body){if(busy||closed)return;busy=true;try{await request(body);await refresh();}catch(error){if(!closed&&host.contains(details))message.textContent=error.message;}finally{busy=false;}}
  function render(){
    if(!settings||!feed||closed)return;
    const unread=feed.items.filter(e=>e.unread).length;summary.textContent='Account updates'+(unread?' · '+unread:'');
    content.replaceChildren(node('h3','Across your Astra products'));
    message.textContent=settings.deliveryHealthy?'Only your account’s currently approved products and evidence are included.':'Updates are reconnecting. Saved updates remain available; new changes may be delayed.';content.append(message);
    const label=node('label',null,'aau-toggle'),toggle=node('input');toggle.type='checkbox';toggle.checked=settings.enabled;
    toggle.onchange=()=>change({action:'preferences',enabled:toggle.checked,useEvidence:settings.canUseEvidence&&settings.useEvidence,revision:settings.revision});
    label.append(toggle,document.createTextNode('Show my account updates'));content.append(label);
    if(settings.canUseEvidence){const label=node('label',null,'aau-toggle'),toggle=node('input');toggle.type='checkbox';toggle.checked=settings.useEvidence;
      toggle.disabled=!settings.enabled;toggle.onchange=()=>change({action:'preferences',enabled:settings.enabled,useEvidence:toggle.checked,revision:settings.revision});
      label.append(toggle,document.createTextNode('Include my latest Workspace sources in Enigma reviews'));content.append(label,node('p','Uses relevant passages from up to three permitted PDFs or other sources during a review. Existing review prices and limits apply.','aau-note'));}
    if(!settings.enabled){content.append(node('p','Account updates are paused here.','aau-note'));return;}
    if(!feed.items.length)content.append(node('p','No recent updates. New evidence and processing changes will appear here.','aau-note'));
    const list=node('ol',null,'aau-list');
    for(const item of feed.items){const product=products[item.product];if(!product||!kinds[item.kind]||!states[item.state])continue;
      const row=node('li'),link=node('a',product[0]+' '+kinds[item.kind]+' · '+states[item.state]);link.href=product[1];link.target='_blank';link.rel='noopener noreferrer';
      row.append(link);const at=new Date(item.occurredAt);if(Number.isFinite(at.getTime())){const time=node('time',at.toLocaleString());time.dateTime=at.toISOString();row.append(time);}
      if(onUse&&item.product==='enigma'&&item.kind==='review'&&item.state==='completed'){const use=node('button','Add to my evidence');use.type='button';use.onclick=async()=>{use.disabled=true;try{await onUse(item);message.textContent='The evidence is in your library. Review it to assess claim connections.';}catch(e){message.textContent=e.message||'Evidence could not be added.';}finally{use.disabled=false;}};row.append(use);}
      list.append(row);
    }
    content.append(list);if(unread){const read=node('button','Mark these updates read');read.type='button';read.onclick=()=>change({action:'read',seq:feed.cursor});content.append(read);}
    const refreshButton=node('button','Refresh');refreshButton.type='button';refreshButton.onclick=refresh;content.append(refreshButton);
  }
  async function refresh(){if(closed)return;controller?.abort();controller=new AbortController();
    try{const data=await request();if(closed)return;if(settings?.accountId&&settings.accountId!==data.settings.accountId){host.replaceChildren();closed=true;return;}
      settings=data.settings;feed=data.feed;render();}
    catch(error){if(!closed&&error.name!=='AbortError'&&host.contains(details))message.textContent=error.message;}}
  const timer=setInterval(()=>{if(!busy&&document.visibilityState==='visible')refresh();},15000);
  const focus=()=>{if(!busy)refresh();};window.addEventListener('focus',focus);refresh();
  return ()=>{closed=true;controller?.abort();clearInterval(timer);window.removeEventListener('focus',focus);host.replaceChildren();};
}
