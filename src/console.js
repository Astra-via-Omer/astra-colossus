const $ = id => document.getElementById(id);
let serviceKey = '', engines = [], lastResult, busy = false, permissions;
function controls() {
  if (!permissions) return;
  $('save-engine').disabled = !permissions.admin || !permissions.engineCreation;
  $('test-draft').disabled = !permissions.admin; $('evaluate-button').disabled = !permissions.admin;
}
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(path, { method, headers: { ...(serviceKey ? { Authorization: `Bearer ${serviceKey}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw Error(data.error?.message || 'The request failed.');
  return data;
}
function download(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url);
}
function show(result, title) { lastResult = result; $('result').textContent = JSON.stringify(result, null, 2); $('result-title').textContent = title; $('download').disabled = false; }
async function task(action) {
  if (busy) return;
  busy = true; const buttons = [...document.querySelectorAll('button')]; const states = buttons.map(b => b.disabled); buttons.forEach(b => { b.disabled = true; }); $('status').textContent = 'Working…';
  try { await action(); $('status').textContent = 'Complete.'; } catch (error) { $('status').textContent = error.message; }
  finally { busy = false; buttons.forEach((b, i) => { b.disabled = states[i]; }); $('download').disabled = !lastResult; controls(); }
}
async function load() {
  const capabilities = await api('/v1/capabilities');
  permissions = capabilities;
  const data = await api('/v1/engines'); engines = data.engines;
  $('engine').replaceChildren(...engines.map((e, i) => new Option(`${e.name} · ${e.version}`, String(i))));
  $('model').replaceChildren(...capabilities.routes.map(r => new Option(`${r.id} · ${r.model}`, r.id)));
  $('room').hidden = false; $('access').hidden = true;
  $('save-engine').disabled = !capabilities.admin || !capabilities.engineCreation;
  $('test-draft').disabled = !capabilities.admin; $('evaluate-button').disabled = !capabilities.admin;
  $('registry-note').textContent = !capabilities.admin ? 'Your account can run saved engines. An admin can create versions and evaluate fixtures.' : capabilities.engineCreation ? 'Saved versions are available to other callers through the engine registry.' : 'Draft testing is available. Configure a durable registry to save versions.';
  $('capabilities').textContent = capabilities.routes.map(r => `${r.id}: ${r.capabilities.join(', ')}`).join(' · ') + ' · Streaming responses: SSE.';
}
function input() { return { focus: $('focus').value, sources: [{ sourceId: $('source-id').value, sectionId: $('section-id').value, text: $('source').value }] }; }
function manifest() { return { id: $('engine-id').value, version: $('version').value, name: $('name').value, model: $('model').value, instruction: $('instruction').value, maxTokens: Number($('tokens').value) }; }
function selected() { const e = engines[Number($('engine').value)]; return { engineId: e.id, engineVersion: e.version }; }
$('login').addEventListener('submit', e => { e.preventDefault(); void task(async () => { const form = new FormData(e.target); await api('/session', Object.fromEntries(form)); e.target.reset(); await load(); }); });
$('key-login').addEventListener('submit', e => { e.preventDefault(); void task(async () => { serviceKey = new FormData(e.target).get('key'); try { await load(); e.target.reset(); } catch (error) { serviceKey = ''; throw error; } }); });
$('logout').addEventListener('click', () => { void task(async () => { serviceKey = ''; await api('/session', undefined, 'DELETE'); $('room').hidden = true; $('access').hidden = false; lastResult = undefined; $('result').textContent = 'Your result will appear here.'; }); });
$('run').addEventListener('submit', e => { e.preventDefault(); void task(async () => show(await api('/v1/runs', { ...selected(), input: input() }), 'Validation complete.')); });
$('create').addEventListener('submit', e => { e.preventDefault(); void task(async () => { const result = await api('/v1/engines', manifest()); show(result, 'Engine version saved.'); await load(); }); });
$('test-draft').addEventListener('click', () => { if (!$('create').reportValidity() || !$('run').reportValidity()) return; void task(async () => show(await api('/v1/engines/test', { engine: manifest(), input: input() }), 'Draft test complete.')); });
$('export').addEventListener('click', () => { if ($('create').reportValidity()) download(manifest(), `${$('engine-id').value}-${$('version').value}.json`); });
$('evaluate').addEventListener('submit', e => { e.preventDefault(); void task(async () => show(await api('/v1/evaluations', { ...selected(), cases: JSON.parse($('cases').value) }), 'Evaluation complete.')); });
$('download').addEventListener('click', () => download(lastResult, 'colossus-result.json'));
$('cases').value = JSON.stringify([{ name: 'Trace a measurement', minClaims: 1, requiredQuote: 'Measured capacity is 20 units in 2026.', input: { focus: 'Capacity evidence', sources: [{ sourceId: 'fixture', sectionId: '1', text: 'Measured capacity is 20 units in 2026.' }] } }], null, 2);
load().then(() => { $('status').textContent = 'Connected.'; }).catch(() => {});
