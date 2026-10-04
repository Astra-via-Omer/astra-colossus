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
  guideMessage('');
  $('save-engine').disabled = !capabilities.admin || !capabilities.engineCreation;
  $('test-draft').disabled = !capabilities.admin; $('evaluate-button').disabled = !capabilities.admin;
  $('registry-note').textContent = !capabilities.admin ? 'Your account can run saved engines. An admin can create versions and evaluate fixtures.' : capabilities.engineCreation ? 'Saved versions are available to other callers through the engine registry.' : 'Draft testing is available. Configure a durable registry to save versions.';
  $('capabilities').textContent = capabilities.routes.map(r => `${r.id}: ${r.capabilities.join(', ')}`).join(' · ') + ' · Streaming responses: SSE.';
}
function input() { return { focus: $('focus').value, sources: [{ sourceId: $('source-id').value, sectionId: $('section-id').value, text: $('source').value }] }; }
function manifest() { return { id: $('engine-id').value, version: $('version').value, name: $('name').value, model: $('model').value, instruction: $('instruction').value, maxTokens: Number($('tokens').value) }; }
function selected() { const e = engines[Number($('engine').value)]; return { engineId: e.id, engineVersion: e.version }; }
const sampleSource = {
  focus: 'Check the capacity claim and identify missing measurement conditions.',
  sources: [{ sourceId: 'measurement-2026', sectionId: 'page-1', text: 'Measured capacity is 20 units in 2026.' }],
};
const sampleCases = [{ name: 'Trace a measurement', minClaims: 1, requiredQuote: sampleSource.sources[0].text, input: sampleSource }];
const guideSteps = [...document.querySelectorAll('.guide-step')];
let guideStep = 0;
function guideMessage(message) { $('guide-feedback').textContent = message; }
function showGuideStep(index, focus = false) {
  if (!Number.isInteger(index) || index < 0 || index >= guideSteps.length) return;
  guideStep = index;
  guideSteps.forEach((step, i) => { step.hidden = i !== index; });
  document.querySelectorAll('#guide-nav [data-guide-step]').forEach(button => {
    if (Number(button.dataset.guideStep) === index) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  });
  $('guide-progress').textContent = `Step ${index + 1} of ${guideSteps.length}`;
  $('guide-back').disabled = index === 0;
  $('guide-next').textContent = index === guideSteps.length - 1 ? 'Finish guide' : 'Next step';
  guideMessage('');
  if (focus) guideSteps[index].querySelector('h2').focus();
}
function goToControl(target) {
  let element;
  if ($('room').hidden) {
    guideMessage('Sign in first to open the engine room. Your guide stays available after sign-in.');
    element = $('login').elements.email;
  } else if (['create', 'test-draft', 'save-engine', 'evaluate'].includes(target) && !permissions?.admin) {
    guideMessage('This step requires an Astra admin account. You can still run saved engine versions.');
    return;
  } else {
    element = { login: $('engine'), run: $('engine'), result: $('result'), create: $('name'),
      'test-draft': $('test-draft'), 'save-engine': $('save-engine'), evaluate: $('cases') }[target];
    if (element?.disabled) {
      guideMessage('This action is unavailable. Check the registry note in the engine creation form.');
      return;
    }
    guideMessage(target === 'login' ? 'You are already signed in. Choose an engine to begin.' : '');
  }
  element?.scrollIntoView({ block: 'center' }); element?.focus({ preventScroll: true });
}
document.querySelectorAll('[data-guide-step]').forEach(button => button.addEventListener('click', event => {
  event.preventDefault(); $('guide').open = true; showGuideStep(Number(button.dataset.guideStep), true);
}));
document.querySelectorAll('[data-guide-target]').forEach(button => button.addEventListener('click', () => goToControl(button.dataset.guideTarget)));
$('guide-back').addEventListener('click', () => showGuideStep(guideStep - 1, true));
$('guide-next').addEventListener('click', () => {
  if (guideStep < guideSteps.length - 1) showGuideStep(guideStep + 1, true);
  else { $('guide').open = false; $('guide').querySelector('summary').focus(); }
});
$('guide-sample-source').addEventListener('click', () => {
  if ($('room').hidden) { goToControl('run'); return; }
  if ($('source').value.trim()) {
    guideMessage('Your current evidence was kept. To load the sample, clear Evidence first, then select Load sample evidence.');
    return;
  }
  const source = sampleSource.sources[0];
  $('source-id').value = source.sourceId; $('section-id').value = source.sectionId;
  $('source').value = source.text; $('focus').value = sampleSource.focus;
  const index = engines.findIndex(engine => engine.id === 'evidence-review' && engine.version === '1.0.0');
  if (index >= 0) $('engine').value = String(index);
  goToControl('run');
  $('status').textContent = 'Sample evidence loaded. Select Run validation when you are ready; this makes a provider call.';
});
$('guide-fixture').textContent = JSON.stringify(sampleCases, null, 2);
$('cases').value = JSON.stringify(sampleCases, null, 2);
showGuideStep(0); $('guide-controls').hidden = false;
if (location.hash === '#guide') $('guide').open = true;
$('login').addEventListener('submit', e => { e.preventDefault(); void task(async () => { const form = new FormData(e.target); await api('/session', Object.fromEntries(form)); e.target.reset(); await load(); }); });
$('key-login').addEventListener('submit', e => { e.preventDefault(); void task(async () => { serviceKey = new FormData(e.target).get('key'); try { await load(); e.target.reset(); } catch (error) { serviceKey = ''; throw error; } }); });
$('logout').addEventListener('click', () => { void task(async () => { serviceKey = ''; await api('/session', undefined, 'DELETE'); $('room').hidden = true; $('access').hidden = false; lastResult = undefined; $('result').textContent = 'Your result will appear here.'; }); });
$('run').addEventListener('submit', e => { e.preventDefault(); void task(async () => show(await api('/v1/runs', { ...selected(), input: input() }), 'Validation complete.')); });
$('create').addEventListener('submit', e => { e.preventDefault(); void task(async () => { const result = await api('/v1/engines', manifest()); show(result, 'Engine version saved.'); await load(); const saved = engines.findIndex(engine => engine.id === result.engine.id && engine.version === result.engine.version); if (saved >= 0) $('engine').value = String(saved); }); });
$('test-draft').addEventListener('click', () => { if (!$('create').reportValidity() || !$('run').reportValidity()) return; void task(async () => show(await api('/v1/engines/test', { engine: manifest(), input: input() }), 'Draft test complete.')); });
$('export').addEventListener('click', () => { if ($('create').reportValidity()) download(manifest(), `${$('engine-id').value}-${$('version').value}.json`); });
$('evaluate').addEventListener('submit', e => { e.preventDefault(); void task(async () => show(await api('/v1/evaluations', { ...selected(), cases: JSON.parse($('cases').value) }), 'Evaluation complete.')); });
$('download').addEventListener('click', () => download(lastResult, 'colossus-result.json'));
load().then(() => { $('status').textContent = 'Connected.'; }).catch(() => {});
