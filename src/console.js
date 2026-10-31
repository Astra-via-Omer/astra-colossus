const $ = id => document.getElementById(id);
let stopAccountUpdates=()=>{},updatesAccount='',updatesVersion=0;
let engines = [], lastResult, busy = false, permissions, account, accountVerified = false, signingOut = false;
let authController = new AbortController(), userOffset = 0, userCount = 0, pendingChange, checkingAccount = false;
let providerSettings, usersLoading = false, userAccessEpoch = 0, usersRequestVersion = 0;
let engineAccessVersion = 0;
let personalAccessVersion = 0;
function controls() {
  const connected = !!account && accountVerified && ['admin', 'professional', 'participant'].includes(account.role), admin = connected && account.role === 'admin' && !!permissions?.admin;
  const operations = connected && (admin || account.role === 'professional');
  document.body.dataset.consoleRole = connected ? account.role : 'checking';
  $('account').hidden = !account; $('room').hidden = !connected;
  $('access-link').hidden = !connected || account.role === 'professional'; $('user-access').hidden = !admin;
  $('access-link').querySelector('span:last-child').textContent = admin ? 'Users & access' : 'My account';
  $('ops-profile').href = admin ? '#user-access' : '#account';
  $('ops-role').textContent = connected ? (admin ? 'Administrator' : account.role === 'professional' ? 'Astra-via Professional · View only' : 'Participant') : 'Verifying access';
  $('ops-refresh').hidden = !operations;
  $('ops-view-access').hidden = !connected || account.role !== 'professional';
  $('engine-studio-description').textContent = admin ? 'Run source validation, publish versioned review instructions and evaluate bounded fixtures.' : 'Run source validation and download traceable results.';
  $('monitor-link').hidden = !operations; $('monitoring').hidden = !operations;
  $('create').closest('section').hidden = !operations; $('evaluate').closest('section').hidden = !operations;
  $('run').querySelector('button').disabled = busy || !connected;
  $('save-engine').disabled = busy || !admin || !permissions?.engineCreation;
  $('test-draft').disabled = busy || !admin; $('evaluate-button').disabled = busy || !admin;
  $('export').disabled = busy || !admin; $('download').disabled = busy || !connected || !lastResult;
  $('logout').disabled = signingOut; $('guide-sample-source').disabled = busy || !connected;
  const accessLocked = busy || usersLoading || !admin || signingOut;
  $('user-search').querySelector('button').disabled = accessLocked;
  $('users-previous').disabled = accessLocked || userOffset === 0;
  $('users-next').disabled = accessLocked || userCount < 50;
  $('confirm-access-change').disabled = busy || !admin || !pendingChange;
  $('cancel-access-change').disabled = busy;
  document.querySelectorAll('#user-rows button, #user-rows select, #user-rows input').forEach(node => { node.disabled = accessLocked || node.dataset.locked === 'true'; });
  const providerDirty = !!providerSettings && $('deepseek-enabled').checked !== providerSettings.deepseekEnabled;
  $('deepseek-enabled').disabled = accessLocked || !providerSettings;
  $('save-provider-settings').disabled = accessLocked || !providerDirty;
  $('cancel-provider-settings').disabled = accessLocked || !providerDirty;
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
  stopAccountUpdates();updatesAccount='';updatesVersion++;
  account = undefined; accountVerified = false; permissions = undefined; engines = []; lastResult = undefined; pendingChange = undefined;
  $('run').reset(); $('create').reset(); $('cases').value = '';
  $('engine').replaceChildren(); $('model').replaceChildren(); clearUserAccess();
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
async function connectAccountUpdates(host) {
  const version = ++updatesVersion;
  stopAccountUpdates();
  // The console is a classic script shared with operations.js. Load the optional
  // account feed separately so its module cannot prevent console startup.
  try {
    const { mountAccountUpdates } = await import('./account-updates.js');
    if (version !== updatesVersion || !accountVerified || signingOut || authController.signal.aborted) return;
    stopAccountUpdates = mountAccountUpdates(host);
  } catch {
    if (version === updatesVersion) host.textContent = 'Account updates are unavailable.';
  }
}
function displayAccount(profile) {
  if (authController.signal.aborted) return;
  if (account && (account.id !== profile.user.id || account.role !== profile.user.role)) clearUserAccess();
  account = profile.user; accountVerified = true;
  if(updatesAccount!==account.id&&$('account-updates')){updatesAccount=account.id;void connectAccountUpdates($('account-updates'));}
  $('greeting').textContent = account.name ? `Welcome back, ${account.name}.` : 'Welcome back.';
  $('account-email').textContent = account.email;
  if ($('ops-account')) $('ops-account').textContent = account.name || account.email;
  if ($('ops-avatar')) $('ops-avatar').textContent = (account.name || account.email || 'A').slice(0, 1).toUpperCase();
  $('account-role').textContent = `Astra ${account.role}`;
  $('account-permissions').textContent = account.role === 'admin'
    ? 'You can monitor usage and costs across all accounts, run engines, create and test versions, evaluate fixtures and manage shared user access.'
    : account.role === 'professional' ? 'You can view Colossus operations, models, groups, providers, API access and costs. Configuration and shared user management require an administrator. Your existing model and product grants still control engine runs.'
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
async function refreshPersonalProviderAccess() {
  if (!accountVerified || signingOut || authController.signal.aborted) return false;
  const version = ++personalAccessVersion, epoch = userAccessEpoch, accountId = account?.id;
  const current = () => version === personalAccessVersion && epoch === userAccessEpoch && accountId === account?.id
    && accountVerified && !signingOut && !authController.signal.aborted;
  $('personal-provider-status').textContent = 'Checking personal provider access…';
  try {
    const personal = await api('/v1/provider-access'); if (!current()) return false;
    if (!['deepseekEnabled', 'googleEnabled', 'deepseekGloballyEnabled', 'effectiveDeepseekEnabled'].every(key => typeof personal[key] === 'boolean')) throw Error('The server did not return confirmed personal provider access.');
    const deepseek = personal.deepseekEnabled
      ? personal.deepseekGloballyEnabled && personal.effectiveDeepseekEnabled ? 'granted' : 'granted; globally disabled'
      : personal.deepseekGloballyEnabled ? 'not granted' : 'not granted; globally disabled';
    $('personal-provider-status').textContent = `Your provider access: Google ${personal.googleEnabled ? 'granted' : 'not granted'} · DeepSeek ${deepseek}. Group assignments and product API grants still apply.`;
    return true;
  } catch (error) {
    if (!current()) return false;
    $('personal-provider-status').textContent = `Personal provider access could not be verified: ${error.message}`; throw error;
  }
}
async function refreshEngineAccess() {
  if (!accountVerified || signingOut || authController.signal.aborted) return false;
  const version = ++engineAccessVersion, epoch = userAccessEpoch, accountId = account?.id;
  const current = () => version === engineAccessVersion && epoch === userAccessEpoch && accountId === account?.id
    && accountVerified && !signingOut && !authController.signal.aborted;
  setEngineModels([]); $('route-count').textContent = 'Checking…'; $('capabilities').textContent = 'Checking eligible model routes…';
  try {
    const capabilities = await api('/v1/capabilities'); if (!current()) return false;
    if (!Array.isArray(capabilities.routes)) throw Error('Eligible model routes could not be verified.');
    permissions = capabilities; setEngineModels(capabilities.routes);
    $('route-count').textContent = String(capabilities.routes.length);
    $('capabilities').textContent = capabilities.routes.map(route => `${route.id}: ${route.capabilities.join(', ')}`).join(' · ') + ' · Streaming responses: SSE.';
    await refreshPersonalProviderAccess().catch(() => false); if (!current()) return false;
    controls(); return true;
  } catch (error) {
    if (!current()) return false;
    setEngineModels([]); $('route-count').textContent = 'Unavailable';
    $('capabilities').textContent = 'Eligible model routes are unavailable. Refresh operations to retry.';
    $('status').textContent = error.message; throw error;
  }
}
document.addEventListener('colossus:catalog', () => { void refreshEngineAccess().catch(() => {}); });
async function load() {
  const epoch = userAccessEpoch, accountId = account?.id;
  const [profile, capabilities] = await Promise.all([api('/session'), api('/v1/capabilities')]);
  const data = await api('/v1/engines');
  if (authController.signal.aborted || signingOut || epoch !== userAccessEpoch || accountId !== account?.id) return;
  permissions = capabilities; engines = data.engines;
  $('engine').replaceChildren(...engines.map((e, i) => new Option(`${e.name} · ${e.version}`, String(i))));
  setEngineModels(capabilities.routes);
  displayAccount(profile);
  void refreshPersonalProviderAccess().catch(() => {});
  $('engine-count').textContent = String(engines.length);
  $('route-count').textContent = String(capabilities.routes.length);
  $('registry-state').textContent = capabilities.engineCreation ? 'Configured' : 'Not configured';
  $('registry-detail').textContent = capabilities.engineCreation ? 'Publishing requires admin access' : 'An admin can test drafts without saving';
  guideMessage('');
  $('registry-note').textContent = !capabilities.admin ? 'Your account can run saved engines. An admin can create versions and evaluate fixtures.' : capabilities.engineCreation ? 'Saved versions are available to other callers through the engine registry.' : 'Draft testing is available. Configure a durable registry to save versions.';
  $('capabilities').textContent = capabilities.routes.map(r => `${r.id}: ${r.capabilities.join(', ')}`).join(' · ') + ' · Streaming responses: SSE.';
  controls();
  void loadMonitoring();
  if (capabilities.admin) void loadUsers().catch(() => {});
  document.dispatchEvent(new CustomEvent('colossus:ready', { detail: { user: account, capabilities } }));
}
async function checkAccount() {
  if (checkingAccount || authController.signal.aborted) return; checkingAccount = true;
  const wasVerified = accountVerified;
  try {
    const profile = await api('/session'), previousRole = account?.role;
    if (authController.signal.aborted) return;
    const identityChanged = account?.id !== profile.user.id;
    if (previousRole !== profile.user.role || identityChanged) {
      permissions = undefined; clearMonitoring();
      document.dispatchEvent(new Event('colossus:locked'));
      clearUserAccess(); pendingChange = undefined; $('access-confirmation').hidden = true;
    }
    displayAccount(profile); controls();
    if (!wasVerified || previousRole !== account.role || identityChanged) await load();
    controls();
    if (!wasVerified) document.dispatchEvent(new CustomEvent('colossus:ready', { detail: { user: account, capabilities: permissions } }));
  } catch (error) {
    if (!authController.signal.aborted) {
      accountVerified = false; clearUserAccess(); pendingChange = undefined; $('access-confirmation').hidden = true; controls();
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
  if (signingOut) return; signingOut = true; clearUserAccess(); controls();
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
function clearUserAccess() {
  userAccessEpoch++; usersRequestVersion++; engineAccessVersion++; personalAccessVersion++; usersLoading = false; userCount = 0; providerSettings = undefined;
  $('user-rows').replaceChildren(); $('deepseek-enabled').checked = false;
  setEngineModels([]); $('route-count').textContent = '—'; $('capabilities').textContent = 'Eligible model routes have not been checked.';
  $('provider-settings-state').textContent = 'Current DeepSeek policy has not been checked.';
  $('provider-settings-status').textContent = '';
  $('personal-provider-status').textContent = 'Personal provider access has not been checked.';
  $('user-access-status').textContent = 'Load users to check current access and provider settings.';
}
function userAccessContext() { return { epoch: userAccessEpoch, accountId: account?.id }; }
function currentUserAccess(context) {
  return context.epoch === userAccessEpoch && context.accountId === account?.id && accountVerified
    && account?.role === 'admin' && permissions?.admin && !signingOut && !authController.signal.aborted;
}
function validProviderRevision(record) { return record && (record.updatedAt === null || typeof record.updatedAt === 'string'); }
function validProviderSettings(record) { return validProviderRevision(record) && typeof record.deepseekEnabled === 'boolean'; }
function validProviderAccess(record) { return validProviderRevision(record) && typeof record.google === 'boolean' && typeof record.deepseek === 'boolean'; }
function renderProviderSettings(record) {
  providerSettings = { ...record }; $('deepseek-enabled').checked = record.deepseekEnabled;
  $('provider-settings-state').textContent = record.deepseekEnabled
    ? 'Saved state: DeepSeek is globally enabled. Each user still needs a DeepSeek grant.'
    : 'Saved state: DeepSeek is globally disabled. User grants can be prepared while it is off.';
  $('provider-settings-status').textContent = ''; controls();
}
function resetProviderSettingsDraft() {
  if (providerSettings) renderProviderSettings(providerSettings);
}
function providerAccessCell(user) {
  const cell = document.createElement('td'); cell.className = 'user-provider-access';
  const available = validProviderAccess(user.providerAccess);
  let saved = available ? { ...user.providerAccess } : undefined;
  const inputs = {}, notes = {};
  for (const [key, name] of [['google', 'Google'], ['deepseek', 'DeepSeek']]) {
    const label = document.createElement('label'), input = document.createElement('input');
    const text = document.createElement('span'), note = document.createElement('small');
    label.className = 'provider-access-check'; input.type = 'checkbox'; input.checked = available && saved[key];
    note.id = `provider-${key}-${encodeURIComponent(user.id)}`;
    input.setAttribute('aria-label', `${name} access for ${user.email}`); input.setAttribute('aria-describedby', note.id); input.dataset.locked = String(!available);
    text.textContent = name; text.append(note); label.append(input, text); cell.append(label);
    inputs[key] = input; notes[key] = note;
  }
  const buttons = document.createElement('div'), save = document.createElement('button'), cancel = document.createElement('button');
  buttons.className = 'actions'; save.type = cancel.type = 'button'; save.className = cancel.className = 'secondary';
  save.textContent = 'Save access'; cancel.textContent = 'Cancel';
  save.setAttribute('aria-label', `Save provider access for ${user.email}`); cancel.setAttribute('aria-label', `Cancel provider changes for ${user.email}`);
  const status = document.createElement('p'); status.className = 'provider-access-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const reset = record => {
    saved = record;
    for (const key of ['google', 'deepseek']) {
      inputs[key].checked = !!saved?.[key];
      notes[key].textContent = !saved ? 'Unavailable' : !saved[key] ? 'Saved: not granted'
        : key === 'deepseek' && !providerSettings?.deepseekEnabled ? 'Saved: granted; globally disabled' : 'Saved: granted';
    }
    save.dataset.locked = cancel.dataset.locked = 'true';
    status.textContent = saved ? '' : 'Provider access could not be verified. Load users again.'; controls();
  };
  for (const input of Object.values(inputs)) input.addEventListener('change', () => {
    const dirty = !!saved && (inputs.google.checked !== saved.google || inputs.deepseek.checked !== saved.deepseek);
    save.dataset.locked = cancel.dataset.locked = String(!dirty);
    status.textContent = dirty ? 'Unsaved changes. Saved grants remain in effect.' : ''; controls();
  });
  cancel.addEventListener('click', () => reset(saved));
  save.addEventListener('click', () => { void task(async () => {
    const context = userAccessContext(); if (!currentUserAccess(context) || !saved) return;
    const body = { google: inputs.google.checked, deepseek: inputs.deepseek.checked, expectedUpdatedAt: saved.updatedAt };
    status.textContent = 'Saving provider access…'; let confirmed = false;
    try {
      const result = await api(`/v1/control/provider-access/${encodeURIComponent(user.id)}`, body);
      if (!currentUserAccess(context)) return;
      if (!validProviderAccess(result.record)) throw Error('The server did not return confirmed provider access.');
      confirmed = true; reset({ ...result.record });
      if (!await loadUsers() || !currentUserAccess(context)) return;
      await refreshEngineAccess();
      if (currentUserAccess(context)) $('user-access-status').textContent = `Provider access saved for ${user.email}. Group assignments and shared role are unchanged.`;
    } catch (error) {
      if (!currentUserAccess(context)) return;
      if (!confirmed) { reset(saved); try { await loadUsers(); await refreshEngineAccess(); } catch {} }
      if (!currentUserAccess(context)) return;
      const message = confirmed ? `Provider access was saved, but current access could not be refreshed: ${error.message}`
        : `Provider access save could not be confirmed: ${error.message}`;
      $('user-access-status').textContent = message; throw Error(message);
    }
  }); });
  buttons.append(save, cancel); cell.append(buttons, status); reset(saved); return cell;
}
function renderUsers(users) {
  $('user-rows').replaceChildren();
  for (const user of users) {
    const row = document.createElement('tr'), email = document.createElement('td'), role = document.createElement('td');
    const state = document.createElement('td'), actions = document.createElement('td');
    email.textContent = user.email + (user.current ? ' (your account)' : ''); state.textContent = user.status;
    const select = document.createElement('select'); select.setAttribute('aria-label', `Role for ${user.email}`);
    for (const name of ['admin', 'professional', 'participant', 'reader', 'viewer']) select.add(new Option(name === 'professional' ? 'Astra-via Professional' : name, name));
    select.value = user.role; select.dataset.locked = String(user.current); role.append(select);
    const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Review role'; save.className = 'secondary';
    save.dataset.locked = String(user.current); save.addEventListener('click', () => reviewChange(user, { role: select.value }));
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.textContent = user.status === 'Suspended' ? 'Enable' : 'Suspend'; toggle.className = 'secondary';
    toggle.dataset.locked = String(user.current || (user.role === 'admin' && user.status !== 'Suspended') || user.status === 'Unconfirmed');
    toggle.addEventListener('click', () => reviewChange(user, { disabled: user.status !== 'Suspended' }));
    actions.className = 'actions'; actions.append(save, toggle); row.append(email, role, state, providerAccessCell(user), actions); $('user-rows').append(row);
  }
  controls();
}
async function loadUsers() {
  const context = userAccessContext(); if (!currentUserAccess(context)) return false;
  const version = ++usersRequestVersion, offset = userOffset, search = $('user-query').value;
  usersLoading = true; providerSettings = undefined; userCount = 0; pendingChange = undefined;
  $('user-rows').replaceChildren(); $('access-confirmation').hidden = true; $('deepseek-enabled').checked = false;
  $('provider-settings-state').textContent = 'Checking the current DeepSeek policy…'; $('provider-settings-status').textContent = '';
  $('user-access-status').textContent = 'Checking shared Astra users…';
  controls();
  try {
    const result = await api(`/v1/access/users?search=${encodeURIComponent(search)}&offset=${offset}`);
    if (!currentUserAccess(context) || version !== usersRequestVersion) return false;
    if (!Array.isArray(result.users) || !validProviderSettings(result.providerSettings)) throw Error('Current provider settings could not be verified. Load users again.');
    renderProviderSettings(result.providerSettings); userCount = result.users.length; renderUsers(result.users);
    $('user-access-status').textContent = userCount ? `Showing users ${offset + 1}–${offset + userCount}. Provider grants apply to Colossus; role and state affect the shared Astra account.` : 'No matching accounts. Global provider settings are current.';
    return true;
  } catch (error) {
    if (!currentUserAccess(context) || version !== usersRequestVersion) return false;
    $('user-rows').replaceChildren(); userCount = 0; providerSettings = undefined; $('deepseek-enabled').checked = false;
    $('provider-settings-state').textContent = 'Current DeepSeek policy is unavailable. Load users to retry.';
    $('provider-settings-status').textContent = error.message; $('user-access-status').textContent = error.message; throw error;
  } finally { if (version === usersRequestVersion && currentUserAccess(context)) { usersLoading = false; controls(); } }
}
$('deepseek-enabled').addEventListener('change', () => {
  $('provider-settings-status').textContent = providerSettings && $('deepseek-enabled').checked !== providerSettings.deepseekEnabled
    ? `Unsaved change. DeepSeek remains globally ${providerSettings.deepseekEnabled ? 'enabled' : 'disabled'} until saved.` : '';
  controls();
});
$('cancel-provider-settings').addEventListener('click', resetProviderSettingsDraft);
$('provider-settings').addEventListener('submit', event => { event.preventDefault(); void task(async () => {
  const context = userAccessContext(); if (!currentUserAccess(context) || !providerSettings) return;
  const body = { deepseekEnabled: $('deepseek-enabled').checked, expectedUpdatedAt: providerSettings.updatedAt };
  $('provider-settings-status').textContent = 'Saving the global DeepSeek setting…'; let confirmed = false;
  try {
    const result = await api('/v1/control/provider-settings', body);
    if (!currentUserAccess(context)) return;
    if (!validProviderSettings(result.record)) throw Error('The server did not return confirmed provider settings.');
    confirmed = true; renderProviderSettings(result.record);
    if (!await loadUsers() || !currentUserAccess(context)) return;
    await refreshEngineAccess();
    if (currentUserAccess(context)) $('provider-settings-status').textContent = 'Global DeepSeek setting saved. User grants and group assignments are unchanged.';
  } catch (error) {
    if (!currentUserAccess(context)) return;
    if (!confirmed) { resetProviderSettingsDraft(); try { await loadUsers(); await refreshEngineAccess(); } catch {} }
    if (!currentUserAccess(context)) return;
    const message = confirmed ? `The DeepSeek setting was saved, but current access could not be refreshed: ${error.message}`
      : `The DeepSeek setting save could not be confirmed: ${error.message}`;
    $('provider-settings-status').textContent = message; $('user-access-status').textContent = message; throw Error(message);
  }
}); });
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
  if (!accountVerified || !['admin', 'professional'].includes(account?.role) || authController.signal.aborted) return;
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
