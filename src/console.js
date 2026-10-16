const $ = id => document.getElementById(id);
let engines = [], lastResult, busy = false, permissions, account, accountVerified = false, signingOut = false;
let authController = new AbortController(), userOffset = 0, userCount = 0, pendingChange, checkingAccount = false;
function controls() {
  const connected = !!account && accountVerified && account.role === 'admin', admin = connected && !!permissions?.admin;
  $('account').hidden = !account; $('room').hidden = !connected;
  $('access-link').hidden = !admin; $('user-access').hidden = !admin;
  $('monitor-link').hidden = !admin; $('monitoring').hidden = !admin;
  $('create').closest('section').hidden = !admin; $('evaluate').closest('section').hidden = !admin;
  $('run').querySelector('button').disabled = busy || !connected;
  $('save-engine').disabled = busy || !admin || !permissions?.engineCreation;
  $('test-draft').disabled = busy || !admin; $('evaluate-button').disabled = busy || !admin;
  $('export').disabled = busy || !admin; $('download').disabled = busy || !connected || !lastResult;
  $('logout').disabled = signingOut; $('guide-sample-source').disabled = busy || !connected;
  $('user-search').querySelector('button').disabled = busy || !admin;
  $('users-previous').disabled = busy || !admin || userOffset === 0;
  $('users-next').disabled = busy || !admin || userCount < 50;
  $('confirm-access-change').disabled = busy || !admin || !pendingChange;
  $('cancel-access-change').disabled = busy;
  document.querySelectorAll('#user-rows button, #user-rows select').forEach(node => { node.disabled = busy || !admin || node.dataset.locked === 'true'; });
}
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(path, { method, credentials: 'same-origin', signal: authController.signal,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) {
    const error = Error(data.error?.message || 'The request failed.'); error.status = response.status; error.code = data.error?.code;
    if (response.status === 401 || error.code === 'access_denied') endSession(response.status === 403 ? 'denied' : 'expired');
    throw error;
  }
  return data;
}
function clearPrivateState() {
  account = undefined; accountVerified = false; permissions = undefined; engines = []; lastResult = undefined; pendingChange = undefined;
  $('run').reset(); $('create').reset(); $('cases').value = '';
  $('engine').replaceChildren(); $('model').replaceChildren(); $('user-rows').replaceChildren();
  $('access-confirmation').hidden = true; $('result').textContent = 'Your result will appear here.';
  $('account-email').textContent = ''; $('account-role').textContent = ''; $('account-permissions').textContent = ''; $('account-expiry').textContent = '';
  $('greeting').textContent = 'Welcome back.';
  clearMonitoring();
  document.dispatchEvent(new Event('colossus:locked'));
  $('engine-count').textContent = '—'; $('route-count').textContent = '—'; $('registry-state').textContent = 'Checking…';
  $('registry-detail').textContent = 'Checked with your account'; controls();
}
function endSession(reason) {
  authController.abort(); clearPrivateState(); location.replace(`/?access=${reason}`);
}
function displayAccount(profile) {
  if (authController.signal.aborted) return;
  account = profile.user; accountVerified = true;
  $('greeting').textContent = account.name ? `Welcome back, ${account.name}.` : 'Welcome back.';
  $('account-email').textContent = account.email;
  if ($('ops-account')) $('ops-account').textContent = account.name || account.email;
  if ($('ops-avatar')) $('ops-avatar').textContent = (account.name || account.email || 'A').slice(0, 1).toUpperCase();
  $('account-role').textContent = `Astra ${account.role}`;
  $('account-permissions').textContent = account.role === 'admin'
    ? 'You can monitor usage and costs across all accounts, run engines, create and test versions, evaluate fixtures and manage shared user access.'
    : 'You can run saved engine versions and download your results. An Astra admin can create, test and evaluate engines.';
  $('account-expiry').textContent = `This Colossus session ends at ${new Date(profile.expiresAt).toLocaleTimeString()}. Sign in again to continue after it expires.`;
}
function download(value, name) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click(); URL.revokeObjectURL(url);
}
function show(result, title) { if (!account || !accountVerified) return; lastResult = result; $('result').textContent = JSON.stringify(result, null, 2); $('result-title').textContent = title; controls(); }
async function task(action) {
  if (busy) return;
  busy = true; controls(); $('status').textContent = 'Working…';
  try { await action(); if (account) $('status').textContent = 'Complete.'; } catch (error) { if (account && !authController.signal.aborted) $('status').textContent = error.message; }
  finally { busy = false; controls(); void loadMonitoring(); }
}
function setEngineModels(routes) {
  const selected = $('model').value;
  const chat = routes.filter(route => !route.task || route.task === 'chat');
  $('model').replaceChildren(...chat.map(route => new Option(`${route.id} · ${route.model}`, route.id)));
  if (chat.some(route => route.id === selected)) $('model').value = selected;
}
document.addEventListener('colossus:catalog', event => { if (accountVerified) setEngineModels(event.detail); });
async function load() {
  const [profile, capabilities] = await Promise.all([api('/session'), api('/v1/capabilities')]);
  permissions = capabilities;
  const data = await api('/v1/engines'); engines = data.engines;
  if (authController.signal.aborted) return;
  $('engine').replaceChildren(...engines.map((e, i) => new Option(`${e.name} · ${e.version}`, String(i))));
  setEngineModels(capabilities.routes);
  displayAccount(profile);
  $('engine-count').textContent = String(engines.length);
  $('route-count').textContent = String(capabilities.routes.length);
  $('registry-state').textContent = capabilities.engineCreation ? 'Configured' : 'Not configured';
  $('registry-detail').textContent = capabilities.engineCreation ? 'Publishing requires admin access' : 'An admin can test drafts without saving';
  guideMessage('');
  $('registry-note').textContent = !capabilities.admin ? 'Your account can run saved engines. An admin can create versions and evaluate fixtures.' : capabilities.engineCreation ? 'Saved versions are available to other callers through the engine registry.' : 'Draft testing is available. Configure a durable registry to save versions.';
  $('capabilities').textContent = capabilities.routes.map(r => `${r.id}: ${r.capabilities.join(', ')}`).join(' · ') + ' · Streaming responses: SSE.';
  controls();
  void loadMonitoring();
  document.dispatchEvent(new CustomEvent('colossus:ready', { detail: { user: account, capabilities } }));
}
async function checkAccount() {
  if (checkingAccount || authController.signal.aborted) return; checkingAccount = true;
  const wasVerified = accountVerified;
  try {
    const profile = await api('/session'), previousRole = account?.role;
    if (authController.signal.aborted) return;
    displayAccount(profile);
    if (previousRole !== account.role) { $('user-rows').replaceChildren(); pendingChange = undefined; $('access-confirmation').hidden = true; await load(); }
    controls();
    if (!wasVerified) document.dispatchEvent(new CustomEvent('colossus:ready', { detail: { user: account, capabilities: permissions } }));
  } catch (error) {
    if (!authController.signal.aborted) {
      accountVerified = false; $('user-rows').replaceChildren(); pendingChange = undefined; $('access-confirmation').hidden = true; controls();
      clearMonitoring();
      document.dispatchEvent(new Event('colossus:locked'));
      $('status').textContent = 'Account access could not be verified. Actions are paused until the shared account service responds.';
    }
  } finally { checkingAccount = false; }
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
    guideMessage('Account access is being checked. Return to the welcome page if you need to sign in again.');
    element = $('account-title');
  } else if (['create', 'test-draft', 'save-engine', 'evaluate'].includes(target) && !permissions?.admin) {
    guideMessage('This step requires an Astra admin account. You can still run saved engine versions.');
    return;
  } else {
    element = { login: $('account-title'), run: $('engine'), result: $('result'), create: $('name'),
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
$('logout').addEventListener('click', async () => {
  if (signingOut) return; signingOut = true; controls();
  try { await api('/session', undefined, 'DELETE'); endSession('signedout'); }
  catch (error) { if (!authController.signal.aborted) $('status').textContent = 'Sign-out could not be confirmed. Try again before leaving this device.'; }
  finally { signingOut = false; controls(); }
});
$('run').addEventListener('submit', e => { e.preventDefault(); void task(async () => show(await api('/v1/runs', { ...selected(), input: input() }), 'Validation complete.')); });
$('create').addEventListener('submit', e => { e.preventDefault(); void task(async () => { const result = await api('/v1/engines', manifest()); show(result, 'Engine version saved.'); await load(); const saved = engines.findIndex(engine => engine.id === result.engine.id && engine.version === result.engine.version); if (saved >= 0) $('engine').value = String(saved); }); });
$('test-draft').addEventListener('click', () => { if (!$('create').reportValidity() || !$('run').reportValidity()) return; void task(async () => show(await api('/v1/engines/test', { engine: manifest(), input: input() }), 'Draft test complete.')); });
$('export').addEventListener('click', () => { if ($('create').reportValidity()) download(manifest(), `${$('engine-id').value}-${$('version').value}.json`); });
$('evaluate').addEventListener('submit', e => { e.preventDefault(); void task(async () => show(await api('/v1/evaluations', { ...selected(), cases: JSON.parse($('cases').value) }), 'Evaluation complete.')); });
$('download').addEventListener('click', () => download(lastResult, 'colossus-result.json'));
function reviewChange(user, change) {
  pendingChange = { userId: user.id, ...change };
  $('access-confirm-text').textContent = Object.hasOwn(change, 'role')
    ? `Change ${user.email} from ${user.role} to ${change.role}?`
    : `${change.disabled ? 'Suspend' : 'Enable'} the shared Astra account ${user.email}?`;
  $('access-confirmation').hidden = false; controls(); $('confirm-access-change').focus();
}
function renderUsers(users) {
  $('user-rows').replaceChildren();
  for (const user of users) {
    const row = document.createElement('tr'), email = document.createElement('td'), role = document.createElement('td');
    const state = document.createElement('td'), actions = document.createElement('td');
    email.textContent = user.email + (user.current ? ' (your account)' : ''); state.textContent = user.status;
    const select = document.createElement('select'); select.setAttribute('aria-label', `Role for ${user.email}`);
    for (const name of ['admin', 'participant', 'reader', 'viewer']) select.add(new Option(name, name));
    select.value = user.role; select.dataset.locked = String(user.current); role.append(select);
    const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Review role'; save.className = 'secondary';
    save.dataset.locked = String(user.current); save.addEventListener('click', () => reviewChange(user, { role: select.value }));
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.textContent = user.status === 'Suspended' ? 'Enable' : 'Suspend'; toggle.className = 'secondary';
    toggle.dataset.locked = String(user.current || (user.role === 'admin' && user.status !== 'Suspended') || user.status === 'Unconfirmed');
    toggle.addEventListener('click', () => reviewChange(user, { disabled: user.status !== 'Suspended' }));
    actions.className = 'actions'; actions.append(save, toggle); row.append(email, role, state, actions); $('user-rows').append(row);
  }
  controls();
}
async function loadUsers() {
  $('user-access-status').textContent = 'Checking shared Astra users…';
  try {
    const result = await api(`/v1/access/users?search=${encodeURIComponent($('user-query').value)}&offset=${userOffset}`);
    if (authController.signal.aborted || !accountVerified || account?.role !== 'admin') return;
    userCount = result.users.length; renderUsers(result.users);
    $('user-access-status').textContent = userCount ? `Showing users ${userOffset + 1}–${userOffset + userCount}. Changes affect the shared Astra account.` : 'No matching accounts.';
  } catch (error) { $('user-rows').replaceChildren(); userCount = 0; $('user-access-status').textContent = error.message; throw error; }
}
$('user-search').addEventListener('submit', event => { event.preventDefault(); userOffset = 0; void task(loadUsers); });
$('users-previous').addEventListener('click', () => { userOffset = Math.max(0, userOffset - 50); void task(loadUsers); });
$('users-next').addEventListener('click', () => { userOffset += 50; void task(loadUsers); });
$('cancel-access-change').addEventListener('click', () => { pendingChange = undefined; $('access-confirmation').hidden = true; controls(); });
$('confirm-access-change').addEventListener('click', () => { void task(async () => {
  const change = pendingChange; if (!change) return;
  await api('/v1/access/users', change, 'PATCH'); pendingChange = undefined; $('access-confirmation').hidden = true;
  await loadUsers(); $('user-access-status').textContent = 'Shared account updated. Access is checked again on each protected request.';
}); });
controls();
load().then(() => { $('status').textContent = 'Your Astra account is connected.'; }).catch(error => {
  if (!authController.signal.aborted) { accountVerified = false; controls(); $('status').textContent = error.message + ' Return to the welcome page to retry sign-in.'; }
});
let monitoringLoading = false, monitoringQueued = false, monitoringVersion = 0;
const number = value => value === null ? 'Unavailable' : new Intl.NumberFormat().format(value);
const money = value => value === null ? 'Unavailable' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 }).format(value);
const unitCost = value => value === null ? 'Unavailable' : '$' + value.toFixed(10);
const duration = value => value === null ? 'Unavailable' : value < 1000 ? `${Math.round(value)} ms` : value < 60000 ? `${(value / 1000).toFixed(1)} s` : `${(value / 60000).toFixed(1)} min`;
function clearMonitoring() {
  monitoringVersion++;
  for (const id of ['monitor-models', 'monitor-users', 'monitor-processes', 'monitor-rates']) $(id).replaceChildren();
  $('monitor-user').replaceChildren(new Option('All accounts & services', ''));
  for (const id of ['metric-tokens', 'metric-cost', 'metric-unit-cost', 'metric-time', 'metric-active', 'metric-average']) $(id).textContent = '—';
  $('monitor-status').textContent = 'Usage is unavailable until admin access is verified.'; $('monitor-coverage').textContent = '';
}
function textRow(values) {
  const row = document.createElement('tr');
  for (const value of values) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
  return row;
}
const operationNames = { run_engine: 'Engine run', test_engine: 'Draft test', evaluate: 'Evaluation', chat: 'Chat inference', embedding: 'Embedding', observe_media: 'Broadcast observation' };
function renderMonitoring(data) {
  const total = data.totals, selectedUser = $('monitor-user').value;
  $('monitor-user').replaceChildren(new Option('All accounts & services', ''), ...data.users.map(user => new Option(user.email || user.id, user.id)));
  $('monitor-user').value = selectedUser;
  $('metric-tokens').textContent = total.calls && !total.reportedCalls ? 'Unavailable' : number(total.totalTokens);
  $('metric-token-detail').textContent = `${number(total.inputTokens)} input · ${number(total.outputTokens)} output`;
  $('metric-cost').textContent = money(total.estimatedCostUsd);
  $('metric-cost-detail').textContent = `${total.pricedCalls} / ${total.calls} calls fully priced${total.costComplete ? '' : ' · incomplete'}`;
  $('metric-unit-cost').textContent = unitCost(total.costPerTokenUsd);
  $('metric-time').textContent = duration(total.providerDurationMs);
  $('metric-time-detail').textContent = `${total.calls} model calls · ${duration(total.durationMs)} finished process time`;
  $('metric-active').textContent = number(total.running);
  $('metric-process-detail').textContent = `${total.processes} processes · ${total.failed} failed / cancelled · ${total.stale} stale`;
  $('metric-average').textContent = duration(total.averageDurationMs);
  $('metric-rate-detail').textContent = `${money(total.costPerProviderMinuteUsd)} / provider processing minute`;
  $('monitor-coverage').textContent = `${total.reportedCalls} / ${total.calls} calls have complete token usage. ${total.usageComplete && total.costComplete ? 'Usage and cost coverage is complete for this selection.' : 'Totals include only reported usage and known cost; missing values are not zero.'} ${data.limited ? 'History reached the 1,000-process query limit. All totals cover this bounded sample; choose a shorter time range.' : ''} ${data.storage === 'process_memory' ? 'Local preview: history is held in this process and resets on restart.' : 'History is shared across service instances.'}`;
  if (data.rates.some(item => item.rates?.basis === 'peak_reference')) $('monitor-coverage').textContent += ' Cost estimates use peak reference rates; off-peak and holiday discounts are not applied.';
  $('monitor-models').replaceChildren(...data.models.map(model => textRow([model.route, number(model.calls), `${number(model.totalTokens)}${model.usageComplete ? '' : ' · partial'}`, `${money(model.estimatedCostUsd)}${model.costComplete ? '' : ' · partial'}`, duration(model.providerDurationMs)])));
  $('monitor-users').replaceChildren(...data.byUser.map(user => textRow([user.actor.email || user.actor.id, number(user.processes), `${number(user.totalTokens)}${user.usageComplete ? '' : ' · partial'}`, `${money(user.estimatedCostUsd)}${user.costComplete ? '' : ' · partial'}`, duration(user.durationMs)])));
  const open = new Set([...$('monitor-processes').querySelectorAll('details[open]')].map(node => node.dataset.requestId));
  $('monitor-processes').replaceChildren(...data.processes.map(process => {
    const details = document.createElement('details'), summary = document.createElement('summary'); details.dataset.requestId = process.requestId; details.open = open.has(process.requestId);
    for (const value of [operationNames[process.operation] || process.operation, process.actor.email || process.actor.id, process.status, duration(process.durationMs), new Date(process.startedAt).toLocaleString()]) { const span = document.createElement('span'); span.textContent = value; summary.append(span); }
    const meta = document.createElement('p'); meta.className = 'guide-hint'; meta.textContent = `Request ${process.requestId}${process.errorCode ? ' · ' + process.errorCode : ''}`;
    details.append(summary, meta);
    for (const call of process.calls) {
      const line = document.createElement('p');
      line.textContent = `Call ${call.index} · ${call.route} / ${call.providerModel}${call.engine ? ' · ' + call.engine.id + '@' + call.engine.version : ''} · ${call.status} · ${duration(call.durationMs)} · ${number(call.usage.inputTokens)} input / ${number(call.usage.outputTokens)} output / ${number(call.usage.totalTokens)} total · ${number(call.usage.cachedInputTokens)} cached input · ${number(call.usage.reasoningTokens)} reasoning · ${money(call.cost.usd)} estimated${call.cost.complete ? '' : ' (incomplete)'}`;
      details.append(line);
      const rates = document.createElement('p'); rates.className = 'guide-hint'; rates.textContent = call.rates ? `Rate snapshot, USD / 1M: input ${call.rates.inputPerMillion}, cached input ${call.rates.cachedInputPerMillion ?? 'unavailable'}, output ${call.rates.outputPerMillion}.${call.rates.basis === 'peak_reference' ? ' Peak reference estimate; off-peak and holiday discounts are not applied.' : ''}` : call.cost.basis || 'No provider rate was configured for this call.'; details.append(rates);
    }
    if (!process.calls.length) { const note = document.createElement('p'); note.textContent = process.status === 'running' ? 'The process is preparing its model call.' : process.status === 'stale' ? 'No completion record is available; model usage may be missing.' : 'No provider call was started.'; details.append(note); }
    return details;
  }));
  if (!data.processes.length) { const empty = document.createElement('p'); empty.textContent = 'No processes recorded in this selection. New activity will appear here.'; $('monitor-processes').append(empty); }
  $('monitor-recent-note').textContent = `Showing ${data.processes.length} of ${total.processes} processes, newest first. Expand a process for model calls, rate snapshots and token details.`;
  $('monitor-rates').replaceChildren(...data.rates.map(item => textRow([`${item.route} / ${item.providerModel}`, item.rates ? money(item.rates.inputPerMillion) : 'Not configured', item.rates?.cachedInputPerMillion !== undefined ? money(item.rates.cachedInputPerMillion) : 'Not configured', item.rates ? money(item.rates.outputPerMillion) : 'Not configured'])));
  $('monitor-status').textContent = `Updated ${new Date(data.generatedAt).toLocaleTimeString()} · refreshes every 15 seconds while this page is visible.`;
  document.dispatchEvent(new CustomEvent('colossus:usage', { detail: data }));
}
async function loadMonitoring() {
  if (!accountVerified || account?.role !== 'admin' || authController.signal.aborted) return;
  if (monitoringLoading) { monitoringQueued = true; return; }
  monitoringQueued = false;
  monitoringLoading = true; $('monitor-refresh').disabled = true;
  const version = monitoringVersion, query = new URLSearchParams({ days: $('monitor-days').value, userId: $('monitor-user').value });
  try { const data = await api('/v1/monitoring?' + query); if (version === monitoringVersion && accountVerified && !authController.signal.aborted) renderMonitoring(data); }
  catch (error) { if (version === monitoringVersion && !authController.signal.aborted) { clearMonitoring(); $('monitor-status').textContent = error.message + ' Usage could not be refreshed.'; } }
  finally { monitoringLoading = false; $('monitor-refresh').disabled = false; if (monitoringQueued) void loadMonitoring(); }
}
$('monitor-filters').addEventListener('submit', event => { event.preventDefault(); void loadMonitoring(); });
for (const id of ['monitor-days', 'monitor-user']) $(id).addEventListener('change', () => { monitoringVersion++; $('monitor-status').textContent = 'Loading the selected usage…'; void loadMonitoring(); });
const accountTimer = setInterval(() => { if (document.visibilityState === 'visible') void checkAccount().then(loadMonitoring); }, 15000);
window.addEventListener('focus', () => { void checkAccount().then(loadMonitoring); });
window.addEventListener('pagehide', () => { clearInterval(accountTimer); authController.abort(); clearPrivateState(); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
