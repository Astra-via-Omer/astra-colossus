import { displayPreferenceKey, displayPreferences, validDisplayPreferences } from './display-contract.mjs';
export class DisplayError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export async function readDisplayBody(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new DisplayError(415, 'Use JSON for display settings.');
  let size = 0; const chunks = [];
  for await (const chunk of request.body || []) { size += chunk.length; if (size > 2048) throw new DisplayError(413, 'The display settings request is too large.'); chunks.push(chunk); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new DisplayError(400, 'Choose valid display settings.'); }
  if (!validDisplayPreferences(value)) throw new DisplayError(400, 'Choose valid display settings.');
  return value;
}
// Call only after the product's normal account/role/session verification.
export async function accountDisplay({ token, userId, url, key, preferences, fetcher = fetch }) {
  if (!token || !userId) throw new DisplayError(401, 'Sign in to use your Astra display settings.');
  if (preferences !== undefined && !validDisplayPreferences(preferences)) throw new DisplayError(400, 'Choose valid display settings.');
  const saving = preferences !== undefined;
  let response, user;
  try {
    response = await fetcher(`${url.replace(/\/$/, '')}/auth/v1/user`, { method: saving ? 'PUT' : 'GET', redirect: 'error', cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, apikey: key, ...(saving ? { 'Content-Type': 'application/json' } : {}) },
      ...(saving ? { body: JSON.stringify({ data: { [displayPreferenceKey]: displayPreferences(preferences) } }) } : {}), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new DisplayError(response.status === 401 || response.status === 403 ? 401 : 503, saving ? 'Your display settings were not confirmed as saved. Please retry.' : 'Your saved display settings could not be loaded.');
    user = await response.json();
  } catch (error) {
    if (error instanceof DisplayError) throw error;
    throw new DisplayError(503, 'Your Astra display settings are temporarily unavailable.');
  }
  const stored = validDisplayPreferences(user?.user_metadata?.[displayPreferenceKey]);
  const value = displayPreferences(user?.user_metadata?.[displayPreferenceKey]);
  if (user?.id !== userId || (saving && (!stored || JSON.stringify(value) !== JSON.stringify(displayPreferences(preferences))))) throw new DisplayError(503, 'The account display settings could not be confirmed.');
  return { userId, preferences: value, stored };
}
