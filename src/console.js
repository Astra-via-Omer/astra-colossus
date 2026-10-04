const $ = id => document.getElementById(id);
let engines = [], lastResult, busy = false, permissions, account, accountVerified = false, signingOut = false;
let authController = new AbortController(), userOffset = 0, userCount = 0, pendingChange, checkingAccount = false;
function controls() {
  const connected = !!account && accountVerified, admin = connected && account.role === 'admin' && !!permissions?.admin;
  $('account').hidden = !account; $('room').hidden = !connected;
  $('access-link').hidden = !admin; $('user-access').hidden = !admin;
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
  $('greeting').textContent = 'Welcome back.'; controls();
}
function endSession(reason) {
  authController.abort(); clearPrivateState(); location.replace(`/?access=${reason}`);
}
function displayAccount(profile) {
  if (authController.signal.aborted) return;
  account = profile.user; accountVerified = true;
  $('greeting').textContent = account.name ? `Welcome back, ${account.name}.` : 'Welcome back.';
  $('account-email').textContent = account.email;
  $('account-role').textContent = `Astra ${account.role}`;
  $('account-permissions').textContent = account.role === 'admin'
    ? 'You can run saved engines, create and test versions, evaluate fixtures and manage shared user access.'
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
  finally { busy = false; controls(); }
}
async function load() {
  const [profile, capabilities] = await Promise.all([api('/session'), api('/v1/capabilities')]);
  permissions = capabilities;
  const data = await api('/v1/engines'); engines = data.engines;
  if (authController.signal.aborted) return;
  $('engine').replaceChildren(...engines.map((e, i) => new Option(`${e.name} · ${e.version}`, String(i))));
  $('model').replaceChildren(...capabilities.routes.map(r => new Option(`${r.id} · ${r.model}`, r.id)));
  displayAccount(profile);
  guideMessage('');
  $('registry-note').textContent = !capabilities.admin ? 'Your account can run saved engines. An admin can create versions and evaluate fixtures.' : capabilities.engineCreation ? 'Saved versions are available to other callers through the engine registry.' : 'Draft testing is available. Configure a durable registry to save versions.';
  $('capabilities').textContent = capabilities.routes.map(r => `${r.id}: ${r.capabilities.join(', ')}`).join(' · ') + ' · Streaming responses: SSE.';
  controls();
}
async function checkAccount() {
  if (checkingAccount || authController.signal.aborted) return; checkingAccount = true;
  try {
    const profile = await api('/session'), previousRole = account?.role;
    if (authController.signal.aborted) return;
    displayAccount(profile);
    if (previousRole !== account.role) { $('user-rows').replaceChildren(); pendingChange = undefined; $('access-confirmation').hidden = true; await load(); }
    controls();
  } catch (error) {
    if (!authController.signal.aborted) {
      accountVerified = false; $('user-rows').replaceChildren(); pendingChange = undefined; $('access-confirmation').hidden = true; controls();
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
const accountTimer = setInterval(() => { if (document.visibilityState === 'visible') void checkAccount(); }, 15000);
window.addEventListener('focus', () => { void checkAccount(); });
window.addEventListener('pagehide', () => { clearInterval(accountTimer); authController.abort(); clearPrivateState(); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
