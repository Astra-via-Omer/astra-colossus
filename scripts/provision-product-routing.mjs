#!/usr/bin/env node
// Coordinated, idempotent routing migration. All credentials stay in memory/stdin.
import { execFileSync } from 'node:child_process';
import { configuration } from '../src/config.mjs';
import { ControlStore } from '../src/controlStore.mjs';
import { ControlPlane } from '../src/controlPlane.mjs';
const args = process.argv.slice(2), option = name => args[args.indexOf(name) + 1];
const account = args.includes('--account') ? option('--account') : '', project = args.includes('--project') ? option('--project') : 'astra-via', apply = args.includes('--apply');
if (!account || !/^[a-z][a-z0-9-]{4,62}$/.test(project)) throw Error('Supply --account and a valid --project; use --apply after reviewing the plan.');
let phase = 'initialization';
const command = (bin, arguments_, input) => {
  try { return execFileSync(bin, arguments_, { input, encoding: 'utf8', maxBuffer: 16000000, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch { throw Error(`${bin} ${arguments_[0]} failed during ${phase}. No credential output was logged.`); }
};
const cloud = (args_, input) => command('gcloud', [...args_, '--project=' + project, '--account=' + account, '--quiet'], input);
const gh = args_ => command('gh', args_);
const repositories = ['Astra-via-Personal-Workspace', 'astra-colossus', 'lab.astra-via', 'astra-enigma', 'evidence-validation'];
const slot = [
 { repo: repositories[0], system: 'workflow', secret: 'astra-workflow-colossus', variable: 'ASTRA_COLOSSUS_SECRET_VERSION', json: true },
 { repo: repositories[2], system: 'lab', secret: 'astra-lab-colossus', variable: 'COLOSSUS_SERVICE_KEY_SECRET_VERSION' },
 { repo: repositories[3], system: 'enigma', secret: 'astra-enigma-colossus', variable: 'COLOSSUS_SERVICE_KEY_SECRET_VERSION' },
 { repo: repositories[4], system: 'evidence', secret: 'astra-evidence-colossus', variable: 'COLOSSUS_SERVICE_KEY_SECRET_VERSION' },
];
const secret = (name, version = 'latest') => cloud(['secrets', 'versions', 'access', version, '--secret=' + name]);
try {
 phase = 'repository metadata';
 const variables = Object.fromEntries(repositories.map(repo => [repo, Object.fromEntries(JSON.parse(gh(['api', '--hostname', 'github.com', `repos/Astra-via-Omer/${repo}/actions/variables?per_page=100`])).variables.map(row => [row.name, row.value]))]));
 for (const repo of repositories) if (variables[repo].GCP_PROJECT_ID !== project || variables[repo].SUPABASE_URL !== variables['astra-colossus'].SUPABASE_URL) throw Error('Product projects and shared account backends must match before migration.');
 phase = 'managed connection configuration';
 const colossusVars = variables['astra-colossus'], workspaceVars = variables[repositories[0]], provider = JSON.parse(secret('astra-provider-config', colossusVars.ASTRA_PROVIDER_SECRET_VERSION || '1'));
 const vault = secret('astra-colossus-vault', colossusVars.COLOSSUS_VAULT_SECRET_VERSION || '1');
 const config = configuration({ NODE_ENV: 'production', GOOGLE_CLOUD_PROJECT: project, COLOSSUS_CONTROL_DATABASE: colossusVars.COLOSSUS_CONTROL_DATABASE || 'astra-colossus',
  COLOSSUS_WORKSPACE_DATABASE: workspaceVars.ASTRA_FIRESTORE_DATABASE || 'astra-workspace', COLOSSUS_VAULT_SECRET: vault, COLOSSUS_ORIGIN: 'https://colossus.astra-via.com', ASTRA_PROVIDER_CONFIG_JSON: JSON.stringify(provider) });
 const cloudToken = command('gcloud', ['auth', 'print-access-token', '--account=' + account]);
 const fetcher = (url, options = {}) => String(url).includes('metadata.google.internal') ? Promise.resolve(Response.json({ access_token: cloudToken, expires_in: 1800 })) : fetch(url, options);
 const store = new ControlStore(config, fetcher), control = new ControlPlane(config, fetcher, fetch, store), actor = { kind: 'operator', id: account, email: account, admin: true };
 const models = await store.list('models'), providers = await store.list('providers');
 const defaultModel = models.find(model => model.id === 'astra-default'), defaultProvider = providers.find(row => row.id === defaultModel?.providerId);
 if (!defaultModel?.enabled || !defaultProvider?.enabled) throw Error('The existing default route must be enabled. This migration does not reactivate paused services.');
 phase = 'approved account inventory';
 const adminKey = secret('astra-supabase-service-role', workspaceVars.SUPABASE_ADMIN_SECRET_VERSION || '1'), users = [];
 for (let page = 1; page <= 10; page++) {
  const response = await fetch(`${workspaceVars.SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=100`, { headers: { apikey: adminKey, Authorization: 'Bearer ' + adminKey }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error('Approved account inventory could not be read.');
  const list = (await response.json()).users;
  if (!Array.isArray(list)) throw Error('Account inventory is invalid.');
  users.push(...list); if (list.length < 100) break; if (page === 10) throw Error('Review the account inventory limit before migration.');
 }
 const buckets = new Map(); let preserved = 0, skipped = 0;
 const allowed = (metadata, system) => metadata.system_access ? metadata.system_access[system] === true : system !== 'evidence' && metadata[system]?.enabled !== false;
 for (const user of users.sort((a,b) => a.id.localeCompare(b.id))) {
  const metadata = user.app_metadata || {};
  if (!user.email_confirmed_at || user.is_anonymous === true || user.deleted_at || metadata.disabled === true || metadata.disabled === 'true' || (user.banned_until && Date.parse(user.banned_until) > Date.now()) || !['admin','participant','reader','viewer'].includes(metadata.role)) { skipped++; continue; }
  if (!['workflow','lab','enigma','evidence'].some(system => allowed(metadata, system))) { skipped++; continue; }
  if ((await store.get('groupMembers/' + user.id)).data?.groupId) { preserved++; continue; }
  let organizationId; try { organizationId = await store.organizationFor(user.id); } catch(error) { if (error.code === 'organization_denied') { skipped++; continue; } throw error; }
  const media = allowed(metadata, 'enigma') && models.some(model => model.id === 'broadcast-media' && model.enabled);
  const key = JSON.stringify({ organizationId, media }), bucket = buckets.get(key) || { organizationId, modelIds: ['astra-default', ...(media ? ['broadcast-media'] : [])], members: [] };
  bucket.members.push(user.id); buckets.set(key, bucket);
 }
 console.log(JSON.stringify({ mode: apply ? 'apply' : 'plan', eligibleUnassigned: [...buckets.values()].reduce((sum,row) => sum + row.members.length, 0), preservedAssignments: preserved, skippedAccounts: skipped, productSecrets: slot.map(row => row.secret), defaultOutputLimit: defaultModel.maxTokens }));
 if (!apply) process.exit(0);
 phase = 'group and route configuration'; await control.ensure();
 if (defaultModel.maxTokens < 8000) await control.save('models', { id: 'astra-default', maxTokens: 8000, expectedUpdatedAt: defaultModel.updatedAt }, actor);
 for (const bucket of buckets.values()) {
  let index = 1, remaining = [...bucket.members];
  while (remaining.length) {
   const suffix = bucket.organizationId || 'personal';
   const groupId = `rollout-${suffix.slice(0,75)}-${bucket.modelIds.length > 1 ? 'media' : 'text'}-${index++}`;
   const previous = (await store.get('groups/' + groupId)).data;
   if (previous && (!previous.enabled || previous.organizationId !== bucket.organizationId || JSON.stringify(previous.modelIds) !== JSON.stringify(bucket.modelIds))) throw Error('A rollout group was changed by an administrator. Review it before adding members.');
   const room = 100 - (previous?.memberIds.length || 0); if (!room) continue;
   const members = [...(previous?.memberIds || []), ...remaining.splice(0, room)];
   await control.save('groups', { id: groupId, name: bucket.organizationId ? `Existing ${bucket.organizationId} users` : 'Existing Astra users', organizationId: bucket.organizationId, memberIds: members, modelIds: bucket.modelIds, ...(previous ? { expectedUpdatedAt: previous.updatedAt } : {}) }, actor);
  }
 }
 const existingSecrets = JSON.parse(cloud(['secrets', 'list', '--format=json'])).map(row => row.name.split('/').at(-1));
 for (const product of slot) {
  phase = product.system + ' scoped connection';
  const runtime = variables[product.repo].GCP_RUNTIME_SERVICE_ACCOUNT;
  if (!runtime || !runtime.endsWith('@' + project + '.iam.gserviceaccount.com')) throw Error('Review the product runtime identity before granting secret access.');
  let payload, current;
  if (existingSecrets.includes(product.secret)) {
   const latest = cloud(['secrets', 'versions', 'list', product.secret, '--filter=state=ENABLED', '--sort-by=~createTime', '--limit=1', '--format=value(name)']);
   if (latest) { payload = secret(product.secret, latest.split('/').at(-1)); try { current = await control.authenticateKey(product.json ? JSON.parse(payload).key : payload); } catch { current = null; } }
  } else cloud(['secrets', 'create', product.secret, '--replication-policy=automatic', '--format=none']);
  const allowedModels = ['astra-default', ...(product.system === 'enigma' && models.some(model => model.id === 'broadcast-media' && model.enabled) ? ['broadcast-media'] : [])];
  if (!current || current.systemId !== product.system || !current.requireGroup || allowedModels.some(alias => !current.allowedModels.includes(alias)) || (product.system === 'lab' && !current.registrationProviderIds.includes(defaultProvider.id))) {
   const issued = await control.issueKey({ name: `${product.system} backend routing`, systemId: product.system, allowedModels, requireGroup: true, expiresInDays: 365, ...(product.system === 'lab' ? { registrationProviderIds: [defaultProvider.id] } : {}) }, actor);
   payload = product.json ? JSON.stringify({ key: issued.oneTimeKey, allowedEmails: provider.allowedEmails || [] }) : issued.oneTimeKey;
   cloud(['secrets', 'versions', 'add', product.secret, '--data-file=-', '--format=value(name)'], payload);
  }
  cloud(['secrets', 'add-iam-policy-binding', product.secret, '--member=serviceAccount:' + runtime, '--role=roles/secretmanager.secretAccessor', '--format=none']);
  const version = cloud(['secrets', 'versions', 'list', product.secret, '--filter=state=ENABLED', '--sort-by=~createTime', '--limit=1', '--format=value(name)']).split('/').at(-1);
  if (!/^\d+$/.test(version)) throw Error('The managed connection version could not be confirmed.');
  gh(['variable', 'set', product.variable, '--repo', 'github.com/Astra-via-Omer/' + product.repo, '--body', version]);
  gh(['variable', 'set', 'COLOSSUS_URL', '--repo', 'github.com/Astra-via-Omer/' + product.repo, '--body', 'https://colossus.astra-via.com']);
  console.log(`${product.system}: scoped connection and numeric deployment version configured.`);
 }
 phase = 'strict routing deployment setting';
 gh(['variable','set','COLOSSUS_REQUIRE_GROUPS','--repo','github.com/Astra-via-Omer/astra-colossus','--body','true']);
 gh(['variable','set','COLOSSUS_WORKSPACE_DATABASE','--repo','github.com/Astra-via-Omer/astra-colossus','--body',config.workspaceDatabase]);
 console.log('Product routing preparation complete. Deploy and verify Colossus before deploying the callers.');
} catch(error) { console.error(`Routing setup stopped during ${phase}: ${error.message}`); process.exitCode = 1; }
