import { fail } from './config.mjs';

export function vertexConfiguration(env) {
  if (!env.COLOSSUS_VERTEX_PROJECT) return null;
  const project = env.COLOSSUS_VERTEX_PROJECT, location = env.COLOSSUS_VERTEX_LOCATION || 'eu';
  const model = env.COLOSSUS_VERTEX_MODEL || 'gemini-3.1-flash-lite';
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project) || !['eu', 'us'].includes(location) || !/^gemini-[a-z0-9.-]{1,100}$/.test(model)) throw Error('Invalid regional Vertex text configuration');
  return { project, location, model, baseUrl: `https://aiplatform.${location}.rep.googleapis.com/v1/projects/${project}/locations/${location}/endpoints/openapi` };
}

export function runtimeVertexRoute(config, route) {
  if (route.protocol !== 'vertex-openai') return false;
  if (!config.vertex || route.baseUrl !== config.vertex.baseUrl) fail(503, 'provider_endpoint_denied', 'The analysis route does not match its approved regional endpoint.');
  return true;
}

export function requireApprovedProvider(config, route) {
  const host = new URL(route.baseUrl).hostname.toLowerCase();
  if (config.production && config.providerMigrationMode !== 'prepare' && (host === 'deepseek.com' || host.endsWith('.deepseek.com'))) {
    fail(503, 'provider_policy', 'This analysis route is unavailable under the production data policy.');
  }
}
