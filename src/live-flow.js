import { LiveScene } from '/live-flow-scene.js';
const byId = id => document.getElementById(id), count = n => Number.isFinite(n) ? n.toLocaleString() : '—';
const clock = value => new Intl.DateTimeFormat(undefined, { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value));
const duration = value => value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`;
const stateName = value => ({ running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', stale: 'Stale / interrupted' })[value] || 'Unknown';
let snapshot, records = [], paused = false, pending = false, timer, selected, sequence = 0, receivedAt = 0, failures = 0, closed = false, dataFresh = false, requestController;
const observedState = value => value === 'running' && !dataFresh ? 'Running at last update' : stateName(value);
const scene = new LiveScene(byId('network'), node => { selected = { node }; inspect(); }, (node, e) => {
  const tip = byId('tooltip'); tip.hidden = !node;
  if (node) { tip.textContent = node.label + (node.model ? ` · ${node.model}` : '') + (node.enabled === false ? ' · Paused in registry' : '') + (node.active ? ` · ${node.active} ${dataFresh ? 'active' : 'last observed active'} path segments` : '');
    tip.style.left = Math.min(innerWidth - 310, Math.max(8, e.clientX + 12)) + 'px'; tip.style.top = Math.max(8, e.clientY - 42) + 'px'; }
});
function element(tag, text, className) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; }
function detail(label, value) { const row = element('div', undefined, 'detail-row'); row.append(element('span', label), element('strong', value ?? 'Unavailable')); byId('selection-details').append(row); }
function options(id, values, all) {
  const select = byId(id), previous = select.value, choices = all ? [['', all], ...values] : values;
  // Do not tear down a focused/open native select on every poll.
  if (select.options.length === choices.length && choices.every(([value, name], i) => select.options[i].value === value && select.options[i].textContent === name)) return;
  select.replaceChildren();
  if (all) { const option = element('option', all); option.value = ''; select.append(option); }
  for (const [value, name] of values) { const option = element('option', name); option.value = value; select.append(option); }
  select.value = [...select.options].some(o => o.value === previous) ? previous : select.options[0]?.value || '';
}
function filtered() {
  return snapshot.records.filter(r => (!byId('product').value || r.systemId === byId('product').value)
    && (!byId('model').value || r.calls.some(c => c.route === byId('model').value))
    && (!byId('state').value || r.status === byId('state').value || r.calls.some(c => c.status === byId('state').value)));
}
function render(fresh = true) {
  if (!snapshot) return;
  const focusKey = document.activeElement?.dataset.focusKey;
  dataFresh = fresh;
  records = filtered(); const calls = records.flatMap(r => r.calls), active = calls.filter(c => c.status === 'running');
  byId('metric-active').textContent = fresh ? count(active.length) : '—';
  byId('metric-users').textContent = count(new Set(records.filter(r => r.actor.kind === 'account').map(r => r.actor.id)).size);
  byId('metric-models').textContent = count(snapshot.catalog.models.length);
  byId('model-detail').textContent = `${snapshot.catalog.models.filter(m => m.enabled).length} enabled · ${snapshot.catalog.models.filter(m => !m.enabled).length} paused`;
  byId('metric-processes').textContent = count(records.length);
  byId('process-detail').textContent = `${records.filter(r => r.status === 'running').length} ${fresh ? 'running' : 'running at last update'} · ${records.filter(r => r.status === 'stale').length} stale`;
  const reported = calls.filter(c => c.usage.totalTokens !== null), complete = calls.every(c => c.usage.complete) && records.every(r => r.status !== 'running' && r.status !== 'stale');
  byId('metric-tokens').textContent = reported.length ? count(reported.reduce((n, c) => n + c.usage.totalTokens, 0)) : !calls.length && !records.some(r => r.status === 'running') ? '0' : '—';
  byId('token-detail').textContent = complete ? 'Reported input and output usage' : `${reported.length} of ${calls.length} calls have reported totals`;
  byId('scope-caption').textContent = snapshot.scope.name;
  byId('coverage-note').textContent = (snapshot.limited ? `Limited to ${snapshot.processLimit} recent processes · ` : '') + '15-minute window' + (fresh ? ' · Refreshes every 2 seconds' : ' · Last observed snapshot');
  const missing = snapshot.integrity.telemetryFailuresOnThisInstance;
  byId('telemetry-warning').hidden = !missing;
  byId('telemetry-warning').textContent = missing ? `${missing} telemetry checkpoints failed on this instance. Activity may be missing. Inference continued; durable usage history remains available in the console.` : '';
  byId('preview-banner').hidden = snapshot.source !== 'local_preview_telemetry';
  byId('source-label').textContent = snapshot.source === 'shared_gateway_telemetry' ? 'SHARED GATEWAY TELEMETRY' : 'LOCAL GATEWAY PREVIEW';
  byId('empty-state').hidden = records.length > 0;
  scene.setConnected(fresh && !paused && !document.hidden); scene.setData(snapshot, records, fresh && !paused && !document.hidden);
  byId('request-rows').replaceChildren(...records.map(r => {
    const row = element('tr'); row.tabIndex = 0; row.dataset.focusKey = 'request:' + r.requestId; row.setAttribute('aria-label', `Inspect ${r.actor.email || r.actor.id}, ${r.systemId}, ${observedState(r.status)}`);
    const actor = element('td', r.actor.email || r.actor.id); actor.append(element('small', r.systemId, 'table-sub'));
    row.append(element('td', clock(r.startedAt)), actor, element('td', r.calls.map(c => c.route).join(', ') || 'Route not yet observed'), element('td', observedState(r.status), 'state-label ' + r.status), element('td', duration(r.durationMs)));
    const choose = () => { selected = { requestId: r.requestId }; scene.selected = null; inspect(); };
    row.addEventListener('click', choose); row.addEventListener('keydown', e => { if (e.key === 'Enter') choose(); }); return row;
  }));
  byId('list-empty').hidden = records.length > 0;
  byId('recent-count').textContent = count(records.length);
  byId('recent-activity').replaceChildren(...records.slice(0, 5).map(r => {
    const item = element('button', undefined, 'recent-item'); item.dataset.focusKey = 'recent:' + r.requestId; item.append(element('strong', r.calls.map(c => c.route).join(', ') || 'Admitted · route pending'));
    const sub = element('small', `${r.systemId} · ${clock(r.startedAt)} · `); sub.append(element('span', observedState(r.status), 'state-label ' + r.status)); item.append(sub);
    item.addEventListener('click', () => { selected = { requestId: r.requestId }; scene.selected = null; inspect(); }); return item;
  }));
  if (!records.length) byId('recent-activity').append(element('p', 'No observed activity in this view.', 'muted'));
  if (focusKey) [...byId('request-rows').children, ...byId('recent-activity').children].find(n => n.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
  inspect();
}
function inspect() {
  byId('selection-details').replaceChildren();
  const record = selected?.requestId ? records.find(r => r.requestId === selected.requestId) : null;
  if (record) {
    byId('selection-title').textContent = record.actor.email || 'Service request'; byId('selection-description').textContent = `${record.systemId} · ${record.operation}`;
    byId('selection-badge').textContent = observedState(record.status).toUpperCase();
    detail('Request', record.requestId); detail('Started', clock(record.startedAt) + ' Jerusalem'); detail('State', observedState(record.status)); detail('Duration', duration(record.durationMs));
    detail('Last observed', clock(record.observedAt) + ' Jerusalem');
    for (const call of record.calls) {
      const p = snapshot.catalog.providers.find(p => p.id === call.providerId), block = element('div', undefined, 'call-path');
      block.append(element('strong', `${call.route} → ${p?.name || call.providerId || 'Provider not observed'}`));
      block.append(element('span', `${call.providerModel || 'Model ID unavailable'} · ${call.execution === 'local_cpu' ? 'Local CPU' : 'Provider call'} · ${observedState(call.status)}`));
      block.append(element('span', `${call.usage.totalTokens === null ? 'Usage pending / unavailable' : count(call.usage.totalTokens) + ' reported tokens'} · ${call.cost.usd === null ? 'Cost unavailable' : '$' + call.cost.usd.toFixed(6) + (call.cost.complete ? '' : ' (incomplete)')}`));
      byId('selection-details').append(block);
    }
    if (record.callsTruncated) detail('Call limit', 'First 128 calls shown');
    if (record.errorCode) detail('Gateway outcome', record.errorCode); return;
  }
  const node = selected?.node ? scene.graph.nodes.find(n => n.id === selected.node.id) : null;
  if (node) {
    byId('selection-title').textContent = node.label; byId('selection-badge').textContent = node.kind.toUpperCase();
    byId('selection-description').textContent = node.kind === 'gateway' ? 'Admissions and observed model calls through Colossus.' : node.kind === 'model' ? 'A registered or observed model route. Availability is registry state, not a provider health probe.' : 'Activity observed in the selected scope and time window.';
    const matching = records.filter(r => node.kind === 'user' ? r.actor.id === node.actorId : node.kind === 'system' ? 'system:' + r.systemId === node.id : node.kind === 'gateway' ? true : r.calls.some(c => node.kind === 'model' ? 'model:' + c.route === node.id : 'provider:' + c.providerId === node.id));
    detail('Processes in view', count(matching.length)); detail(dataFresh ? 'Running processes' : 'Running at last update', count(matching.filter(r => r.status === 'running').length));
    if (node.model) detail('Deployed model ID', node.model); if (node.task) detail('Task', node.task);
    if (typeof node.enabled === 'boolean') detail('Registry state', node.enabled ? 'Enabled' : 'Paused');
    return;
  }
  selected = null; byId('selection-title').textContent = 'See the actual route.'; byId('selection-badge').textContent = 'LIVE VIEW';
  byId('selection-description').textContent = 'Select a person, product, model or provider. Select a request in List view to inspect its recorded calls.';
}
function status(label, connected = false, error = false) {
  byId('connection-status').textContent = label; byId('connection-dot').className = 'status-dot' + (connected ? ' connected' : error ? ' error' : '');
  scene.setConnected(connected && !paused && !document.hidden);
}
function clearSnapshot() {
  snapshot = null; records = []; selected = null; dataFresh = false; scene.clear();
  for (const id of ['request-rows', 'recent-activity', 'selection-details']) byId(id).replaceChildren();
  for (const id of ['metric-active', 'metric-users', 'metric-models', 'metric-processes', 'metric-tokens']) byId(id).textContent = '—';
  for (const id of ['model-detail', 'process-detail', 'token-detail']) byId(id).textContent = 'Waiting for verified telemetry';
  byId('selection-title').textContent = 'Verifying activity scope'; byId('selection-description').textContent = 'The previous scope has been cleared.';
  byId('selection-badge').textContent = 'VERIFYING'; byId('recent-count').textContent = '0'; byId('last-update').textContent = 'Waiting for a verified snapshot';
  byId('scope-caption').textContent = 'Verifying scope'; byId('coverage-note').textContent = 'Waiting for telemetry'; byId('telemetry-warning').hidden = true;
}
async function refresh(force = false) {
  if (pending || closed || document.hidden || (paused && !force)) return;
  pending = true; const version = ++sequence; clearTimeout(timer); requestController = new AbortController();
  const scope = byId('scope').value;
  try {
    const response = await fetch('/v1/live-flow' + (scope ? '?scope=' + encodeURIComponent(scope) : ''), { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([requestController.signal, AbortSignal.timeout(12000)]) });
    const data = await response.json(); if (version !== sequence) return;
    if (!response.ok) {
      const error = Error(data.error?.message || 'Live telemetry is unavailable.'); error.status = response.status; throw error;
    }
    snapshot = data; failures = 0; receivedAt = performance.now();
    byId('last-update').textContent = `${clock(data.generatedAt)} Jerusalem · just now`;
    options('scope', data.availableScopes.map(s => [s.kind, s.name])); byId('scope').value = data.scope.kind;
    options('product', data.catalog.systems.map(s => [s.id, s.name]), 'All products in view');
    options('model', data.catalog.models.map(m => [m.id, m.name]), 'All models in view');
    byId('viewer-email').textContent = data.viewer.email; byId('console-link').hidden = !data.viewer.console;
    byId('access-message').hidden = true; status(paused ? 'Paused view' : 'Connected · 2s refresh', !paused); render(!paused);
  } catch (error) {
    if (version !== sequence) return; failures++;
    status(error.status === 401 ? 'Sign-in required' : error.status === 403 ? 'Access changed' : 'Connection interrupted', false, true);
    if (snapshot) render(false);
    byId('metric-active').textContent = '—'; byId('access-message').hidden = false;
    byId('access-message').textContent = error.status === 401 ? 'Your session has ended. Sign in again to view activity.' : error.message;
    if ([401, 403].includes(error.status)) {
      clearSnapshot();
      byId('scope').replaceChildren(); byId('product').replaceChildren(); byId('model').replaceChildren(); byId('viewer-email').textContent = 'Access verification required';
      byId('selection-title').textContent = 'Access verification required'; byId('selection-description').textContent = 'The previous scope has been cleared.';
      if (error.status === 401) { closed = true; const link = element('a', ' Sign in'); link.href = '/?next=live'; byId('access-message').append(link); }
    }
  } finally {
    if (version === sequence) {
      pending = false;
      if (!closed && !paused && !document.hidden) timer = setTimeout(() => refresh(), Math.min(10000, 2000 * 2 ** Math.min(failures, 2)));
    }
  }
}
for (const id of ['product', 'model', 'state']) byId(id).addEventListener('change', () => { selected = null; scene.selected = null; if (snapshot) render(!paused && !failures); });
byId('scope').addEventListener('change', () => { sequence++; requestController?.abort(); pending = false; clearSnapshot(); byId('product').replaceChildren(); byId('model').replaceChildren(); status('Verifying scope'); refresh(true); });
byId('view-3d').addEventListener('click', () => { byId('scene-wrap').hidden = false; byId('list-wrap').hidden = true; byId('view-3d').setAttribute('aria-pressed', 'true'); byId('view-list').setAttribute('aria-pressed', 'false'); });
byId('view-list').addEventListener('click', () => { byId('scene-wrap').hidden = true; byId('list-wrap').hidden = false; byId('view-3d').setAttribute('aria-pressed', 'false'); byId('view-list').setAttribute('aria-pressed', 'true'); });
byId('reset-view').addEventListener('click', () => { selected = null; scene.reset(); inspect(); });
byId('pause').addEventListener('click', () => { paused = !paused; byId('pause').textContent = paused ? 'Resume' : 'Pause'; byId('pause').setAttribute('aria-pressed', String(paused)); clearTimeout(timer); status(paused ? 'Paused view' : 'Reconnecting', false); if (snapshot) render(false); if (!paused) refresh(true); });
byId('refresh').addEventListener('click', () => refresh(true));
byId('sign-out').addEventListener('click', async () => { closed = true; sequence++; clearTimeout(timer); scene.clear(); try { await fetch('/session', { method: 'DELETE', credentials: 'same-origin' }); } finally { location.assign('/?next=live'); } });
document.addEventListener('visibilitychange', () => { clearTimeout(timer); if (document.hidden) { scene.setConnected(false); status('Tab inactive', false); if (snapshot) render(false); } else if (!paused && !closed) refresh(true); });
window.addEventListener('offline', () => { status('Browser offline', false, true); if (snapshot) render(false); });
window.addEventListener('online', () => refresh(true));
window.addEventListener('pagehide', () => { closed = true; sequence++; clearTimeout(timer); scene.destroy(); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
setInterval(() => {
  if (!snapshot) return;
  const age = Math.floor((performance.now() - receivedAt) / 1000);
  byId('last-update').textContent = `${clock(snapshot.generatedAt)} Jerusalem · ${age}s ago`;
  if (age > 7 && !paused && !document.hidden && !closed) { status('Snapshot stale · reconnecting', false, true); if (dataFresh) render(false); }
}, 1000);
refresh();
