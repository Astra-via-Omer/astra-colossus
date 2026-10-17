import { displayFonts, defaultDisplayPreferences, displayPreferences, validDisplayPreferences } from './display-contract.mjs';

const script = document.querySelector('script[data-astra-display]');
const endpoint = script?.dataset.endpoint || '/api/preferences';
let owner = null, saved = { ...defaultDisplayPreferences }, draft = { ...saved }, stored = false, saving = false, loading = false, epoch = 0, changedElsewhere = false;
const root = document.documentElement;
function apply(value) {
  const p = displayPreferences(value);
  root.style.setProperty('--astra-font-family', displayFonts[p.font].family);
  root.style.setProperty('--astra-text-size', p.textSize + 'px');
  root.style.setProperty('--astra-text-weight', { regular: '400', medium: '500', bold: '600' }[p.textWeight]);
  root.style.setProperty('--astra-emphasis-weight', { regular: '600', medium: '650', bold: '750' }[p.textWeight]);
  root.style.setProperty('--astra-line-height', p.spacing === 'roomy' ? '1.95' : '1.7');
  root.dataset.astraContrast = p.contrast; root.dataset.astraMotion = p.motion;
}
apply(saved);
const el = (tag, text, className) => { const value = document.createElement(tag); if (text) value.textContent = text; if (className) value.className = className; return value; };
const dialog = el('dialog', '', 'astra-display-dialog'); dialog.setAttribute('aria-labelledby', 'astra-display-title');
const heading = el('h2', 'Make text easier to read.'); heading.id = 'astra-display-title'; heading.tabIndex = -1;
const intro = el('p', 'Save one personal display preference for Workflow, Colossus, Lab and Enigma. It follows your Astra account across products and devices.');
const fields = el('fieldset', '', 'astra-display-fields'); fields.append(el('legend', 'Text and display options', 'sr-only'));
const controls = new Map();
const options = {
  font: ['Font', Object.entries(displayFonts).map(([id, font]) => [id, font.label])],
  textSize: ['Text size', [[14, 'Compact · 14px'], [16, 'Standard · 16px'], [18, 'Large · 18px'], [20, 'Extra large · 20px'], [22, 'Very large · 22px']]],
  textWeight: ['Text weight', [['regular', 'Regular'], ['medium', 'Medium · clearer default'], ['bold', 'Bold']]],
  spacing: ['Line spacing', [['comfortable', 'Comfortable'], ['roomy', 'Roomy']]],
  contrast: ['Contrast', [['high', 'High · clearer default'], ['standard', 'Standard']]],
  motion: ['Motion', [['system', 'Follow device preference'], ['reduced', 'Reduce motion']]],
};
for (const [key, [label, values]] of Object.entries(options)) {
  const wrap = el('label'), title = el('span', label), select = el('select'); select.name = key;
  for (const [value, text] of values) select.add(new Option(text, String(value)));
  select.addEventListener('change', () => { draft = { ...draft, [key]: key === 'textSize' ? Number(select.value) : select.value }; apply(draft); status(); });
  controls.set(key, select); wrap.append(title, select); fields.append(wrap);
}
const preview = el('section', '', 'astra-display-preview'); preview.setAttribute('aria-label', 'Display preview');
preview.append(el('h3', 'Clearer text. Your choice.'), el('p', 'Review model activity, compare results, and understand your next step.'), el('p', 'Aa Bb Cc · 0123456789'));
const message = el('p'); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
const error = el('p', '', 'astra-display-error'); error.setAttribute('role', 'alert');
const actions = el('div', '', 'astra-display-actions');
const cancel = el('button', 'Close', 'astra-display-secondary'), reset = el('button', 'Restore clearer defaults', 'astra-display-secondary'), reload = el('button', 'Reload saved settings', 'astra-display-secondary'), save = el('button', 'Save to Astra account');
for (const button of [cancel, reset, reload, save]) button.type = 'button'; actions.append(save, reset, reload, cancel);
dialog.append(heading, intro, fields, preview, message, error, actions); document.body.append(dialog);
const dirty = () => JSON.stringify(draft) !== JSON.stringify(saved);
function status() {
  fields.disabled = saving || loading;
  save.disabled = saving || loading || !owner || changedElsewhere || (!dirty() && stored);
  reset.disabled = saving || loading; reload.disabled = saving || loading; cancel.disabled = saving;
  message.textContent = loading ? 'Loading your Astra display settings…' : saving ? 'Saving to your Astra account…' : !owner ? 'Sign in to save your personal display settings.' : changedElsewhere ? 'Your settings changed in another product. Reload saved settings before saving.' : dirty() ? 'Previewing changes. Save to apply them across Astra products.' : stored ? 'Saved to your Astra account. Other products refresh these settings when you return to them.' : 'Using clearer defaults. Choose your settings and save them to your account.';
}
function fill() { for (const [key, select] of controls) select.value = String(draft[key]); status(); }
async function request(method = 'GET', preferences) {
  const response = await fetch(endpoint, { method, credentials: 'same-origin', cache: 'no-store', ...(preferences ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(preferences) } : {}) });
  const data = await response.json();
  if (!response.ok) { const failure = Error(data.error?.message || data.error || 'Your display settings could not be confirmed.'); failure.status = response.status; throw failure; }
  if (typeof data.userId !== 'string' || !validDisplayPreferences(data.preferences)) throw Error('The account settings response was invalid.');
  return data;
}
async function refresh(force = false) {
  if (saving || loading || document.visibilityState === 'hidden') return;
  const generation = epoch; loading = true; if (dialog.open) status();
  try {
    const data = await request(); if (generation !== epoch) return;
    const next = displayPreferences(data.preferences);
    if (force || owner !== data.userId || !dialog.open || !dirty()) { owner = data.userId; saved = next; draft = { ...next }; stored = data.stored === true; changedElsewhere = false; apply(draft); error.textContent = ''; fill(); }
    else if (JSON.stringify(next) !== JSON.stringify(saved)) changedElsewhere = true;
  } catch (failure) {
    if (generation !== epoch) return;
    if ([401, 403].includes(failure.status)) { owner = null; stored = false; saved = { ...defaultDisplayPreferences }; draft = { ...saved }; changedElsewhere = false; apply(draft); fill(); }
    else if (dialog.open) error.textContent = failure.message;
  } finally { if (generation === epoch) { loading = false; status(); } }
}
function close() { if (saving) return; dialog.close(); draft = { ...saved }; changedElsewhere = false; apply(saved); fill(); }
cancel.addEventListener('click', close);
dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
reset.addEventListener('click', () => { draft = { ...defaultDisplayPreferences }; apply(draft); fill(); });
reload.addEventListener('click', () => { void refresh(true); });
save.addEventListener('click', async () => {
  if (!owner || saving || loading || changedElsewhere) return;
  const generation = epoch, account = owner, value = { ...draft }; saving = true; error.textContent = ''; status();
  try {
    const current = await request(); if (generation !== epoch || owner !== account) return;
    if (current.userId !== account) { owner = null; throw Error('Your account changed. Reload saved settings.'); }
    if (JSON.stringify(displayPreferences(current.preferences)) !== JSON.stringify(saved)) { changedElsewhere = true; throw Error('Your settings changed elsewhere. Reload saved settings before saving.'); }
    const result = await request('PUT', value); if (generation !== epoch || owner !== account) return;
    if (result.userId !== account || !result.stored || JSON.stringify(displayPreferences(result.preferences)) !== JSON.stringify(value)) throw Error('Your settings were not confirmed as saved.');
    saved = displayPreferences(result.preferences); draft = { ...saved }; stored = true; apply(saved); fill();
  } catch (failure) { if (generation === epoch) error.textContent = failure.message; }
  finally { if (generation === epoch) { saving = false; status(); } }
});
document.addEventListener('click', event => { if (event.target.closest('[data-astra-display-open]')) { error.textContent = ''; draft = { ...saved }; changedElsewhere = false; fill(); dialog.dataset.palette = getComputedStyle(document.querySelector('.lab-shell') || root).colorScheme.includes('dark') ? 'dark' : 'light'; dialog.showModal(); dialog.scrollTop = 0; heading.focus({ preventScroll: true }); void refresh(); } });
window.addEventListener('focus', () => { void refresh(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refresh(); });
document.addEventListener('colossus:ready', () => { void refresh(); });
document.addEventListener('colossus:locked', () => { epoch++; owner = null; loading = false; saving = false; stored = false; saved = { ...defaultDisplayPreferences }; draft = { ...saved }; apply(saved); dialog.close(); error.textContent = ''; fill(); });
let timer = setInterval(() => { void refresh(); }, 60000);
window.addEventListener('pagehide', () => { clearInterval(timer); timer = null; epoch++; loading = false; saving = false; });
window.addEventListener('pageshow', event => { if (event.persisted) { epoch++; if (!timer) timer = setInterval(() => { void refresh(); }, 60000); void refresh(); } });
fill(); void refresh();
