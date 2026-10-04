const form = document.getElementById('welcome-login'), status = document.getElementById('welcome-status');
let busy = false;
const destination = () => location.hash === '#guide' ? '/app#guide' : '/app';
async function session(method = 'GET', body) {
  const response = await fetch('/session', { method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) { const error = Error(data.error?.message || 'Account access could not be checked.'); error.status = response.status; throw error; }
  return data;
}
function signedIn(data) {
  form.hidden = true; document.getElementById('welcome-account').hidden = false;
  document.getElementById('welcome-title').textContent = data.user.name ? `Welcome back, ${data.user.name}.` : 'Welcome back.';
  document.getElementById('welcome-description').textContent = 'Your Astra account is connected. Continue to your engine room.';
  document.getElementById('welcome-identity').textContent = data.user.email;
  document.getElementById('welcome-role').textContent = `Astra ${data.user.role}`;
  document.getElementById('welcome-continue').href = destination();
}
form.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return; busy = true;
  document.getElementById('welcome-submit').disabled = true; status.textContent = 'Checking your Astra account…';
  try { await session('POST', Object.fromEntries(new FormData(form))); form.reset(); location.assign(destination()); }
  catch (error) { status.textContent = error.message; document.getElementById('welcome-password').value = ''; }
  finally { busy = false; document.getElementById('welcome-submit').disabled = false; }
});
document.getElementById('welcome-signout').addEventListener('click', async () => {
  if (busy) return; busy = true; document.getElementById('welcome-signout').disabled = true;
  try { await session('DELETE'); location.replace('/?access=signedout'); }
  catch (error) { status.textContent = error.message; }
  finally { busy = false; document.getElementById('welcome-signout').disabled = false; }
});
const reason = new URLSearchParams(location.search).get('access');
status.textContent = ({ denied: 'This Astra account cannot access Colossus. Contact your administrator.',
  signin: 'Sign in to open your protected engine room.', expired: 'Your session has ended. Sign in again.',
  signedout: 'You are signed out of Colossus.' })[reason] || (location.hash === '#guide' ? 'Sign in to open the step-by-step guide.' : '');
session().then(signedIn).catch(error => { if (error.status !== 401) status.textContent = error.message; });
