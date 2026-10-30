// Isolated visual fixture: no environment credentials, external requests or paid inference.
import { configuration } from '../src/config.mjs';
import { createService } from '../src/server.mjs';

const port = Number(process.env.PREVIEW_PORT || 4018), origin = `http://127.0.0.1:${port}`;
const people = [
  ['admin', 'admin', '11111111-1111-4111-8111-111111111111'],
  ['professional', 'professional', '22222222-2222-4222-8222-222222222222'],
  ['alice', 'participant', '33333333-3333-4333-8333-333333333333'],
  ['bob', 'reader', '44444444-4444-4444-8444-444444444444'],
];
const users = Object.fromEntries(people.map(([name, role, id]) => [name, { id, email: `${name}@example.invalid`, app_metadata: { role, system_access: { colossus: true } } }]));
const config = configuration({ COLOSSUS_ORIGIN: origin, COLOSSUS_REQUIRE_GROUPS: 'false', SUPABASE_URL: 'https://auth.example.invalid', SUPABASE_ANON_KEY: 'synthetic-preview-key',
  COLOSSUS_ROUTES_JSON: JSON.stringify({
    'astra-default': { baseUrl: 'https://google.example.invalid/v1', model: 'synthetic-google-model', capabilities: ['text'] },
    'deepseek-preview': { baseUrl: 'https://deepseek.example.invalid/v1', model: 'synthetic-deepseek-model', capabilities: ['text'] },
  }), ASTRA_PROVIDER_CONFIG_JSON: '{"key":"synthetic-preview-provider-key"}' });
const app = createService(config, { logger: () => {}, fetcher: async (url, options = {}) => {
  if (url.endsWith('/auth/v1/user')) {
    const name = options.headers.Authorization.replace('Bearer preview-', '');
    return Response.json(users[name] || {}, { status: users[name] ? 200 : 401 });
  }
  if (url.includes('/auth/v1/token')) {
    const input = JSON.parse(options.body), name = input.email.split('@')[0];
    return input.password === 'preview-only' && users[name]
      ? Response.json({ access_token: 'preview-' + name, expires_in: 3600 }) : Response.json({ error: 'invalid_credentials' }, { status: 400 });
  }
  throw Error('The visual preview never calls an external service.');
} });
await app.control.ensure();
const admin = { kind: 'account', id: users.admin.id, admin: true, astraAdmin: true };
await app.control.save('groups', { id: 'research', name: 'Research team', memberIds: [users.professional.id, users.alice.id], modelIds: ['astra-default', 'deepseek-preview'] }, admin);
await app.control.store.mutate(['workspaceMembers/' + users.professional.id, 'workspaceOrganizations/research'], () => [{ status: 'active', orgId: 'research' }, { status: 'active', name: 'Research organization' }]);
const models = await app.control.store.list('models');
for (const model of models.filter(m => !m.native)) {
  await app.control.store.mutate(['providers/' + model.providerId], ([p]) => [{ ...p, name: model.id === 'astra-default' ? 'Google · preview' : 'DeepSeek · preview' }]);
}
const routes = models.filter(m => ['astra-default', 'deepseek-preview'].includes(m.id) || m.model === 'christopher@0.2.0');
if (!routes.some(m => m.native)) routes.push(models.find(m => m.native));
let cursor = 0, stopping = false;
const timers = new Set();
async function emit() {
  if (stopping) return;
  const index = cursor++, user = people[index % people.length], model = routes[index % routes.length];
  if (!model) return;
  const identity = { kind: 'account', id: user[2], email: users[user[0]].email, systemId: ['enigma', 'workflow', 'lab'][index % 3], groupId: index % 4 === 3 ? 'other-team' : 'research', organizationId: index % 4 === 3 ? 'other' : 'research' };
  const record = await app.monitoring.start(identity, `preview-${index}`, 'preview_synthetic_call');
  const call = app.monitoring.call(record, { alias: model.id, model: model.model }, model.native ? { id: 'christopher', version: model.model.split('@')[1] } : null);
  call.providerId = model.providerId; call.execution = model.native ? 'local_cpu' : 'provider';
  const timer = setTimeout(async () => {
    timers.delete(timer);
    const failed = index % 9 === 7;
    app.monitoring.finishCall(call, failed ? 'failed' : 'completed', failed ? undefined : { prompt_tokens: model.native ? 0 : 120, completion_tokens: model.native ? 0 : 45, total_tokens: model.native ? 0 : 165 }, failed ? 502 : 200);
    await app.monitoring.finish(record, failed ? 'failed' : 'completed', failed ? 'synthetic_provider_error' : undefined);
  }, 4500 + (index % 3) * 1500);
  timers.add(timer);
}
await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
for (let i = 0; i < 4; i++) await emit();
const interval = setInterval(() => void emit(), 3500);
console.log(`Local: ${origin}/?next=live`);
console.log('Synthetic preview only. Sign in as admin@example.invalid, professional@example.invalid, alice@example.invalid or bob@example.invalid. Password: preview-only');
async function stop() {
  if (stopping) return; stopping = true; clearInterval(interval); for (const timer of timers) clearTimeout(timer);
  await app.liveFlow.drain(); app.server.closeAllConnections(); app.server.close();
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
