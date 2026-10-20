import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import { createService } from '../src/server.mjs';
import { configuration } from '../src/config.mjs';
import { evaluateChristopher } from '../src/christopher.mjs';

const root = new URL('../', import.meta.url);
const input = JSON.parse(await readFile(new URL('examples/christopher/r42.json', root), 'utf8'));
let providerRequests = 0;
const app = createService(configuration({ ASTRA_PROVIDER_CONFIG_JSON: '{"key":"unused-native-demo-provider","model":"unused-model"}',
  COLOSSUS_API_KEYS_JSON: '["christopher-local-demo"]', COLOSSUS_ADMIN_KEY: randomBytes(32).toString('hex'), COLOSSUS_REQUIRE_GROUPS: 'false' }), {
  fetcher: async () => { providerRequests++; throw Error('Provider access is disabled for the mathematical validation run.'); }, logger: () => {} });
await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(process.argv.includes('--serve') ? Number(process.env.PORT || 4014) : 0, '127.0.0.1', resolve); });
const baseUrl = 'http://127.0.0.1:' + app.server.address().port;
if (process.argv.includes('--serve')) {
  console.log(JSON.stringify({ service: 'colossus', model: 'christopher@0.1.0', url: baseUrl, manifest: baseUrl + '/v1/christopher', execution: 'local_cpu', authentication: 'Use the documented local demo bearer token.', externalProviders: 'disabled' }));
  process.on('SIGTERM', () => app.server.close()); process.on('SIGINT', () => app.server.close());
} else {
  try {
    const files = (await readdir(new URL('test/', root))).filter(name => name.endsWith('.test.mjs')).sort().map(name => 'test/' + name);
    const testOutput = execFileSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: root, encoding: 'utf8', timeout: 60000 });
    const oracle = JSON.parse(await readFile(new URL('test/fixtures/christopher-oracle.json', root), 'utf8'));
    const samples = [], httpSamples = [];
    for (let i = 0; i < 110; i++) { const start = performance.now(); await evaluateChristopher(input); if (i >= 10) samples.push(performance.now() - start); }
    let responseExample;
    for (let i = 0; i < 30; i++) {
      const start = performance.now(); const res = await fetch(baseUrl + '/v1/christopher/evaluate', { method: 'POST', headers: { Authorization: 'Bearer christopher-local-demo', 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
      responseExample = await res.json(); if (!res.ok) throw Error('Local HTTP check failed: ' + res.status); httpSamples.push(performance.now() - start);
    }
    if (providerRequests !== 0 || responseExample.claims[0].gap.lower !== '0' || responseExample.claims[0].gap.upper !== '2') throw Error('Validation invariant failed.');
    const stats = a => { const sorted = [...a].sort((x, y) => x - y); return { runs: a.length, medianMs: sorted[Math.floor(a.length / 2)], p95Ms: sorted[Math.min(a.length - 1, Math.ceil(a.length * .95) - 1)] }; };
    const result = { model: 'christopher@0.1.0', generatedAt: new Date().toISOString(), nodeVersion: process.version,
      tests: { passed: Number(/# pass (\d+)/.exec(testOutput)?.[1]), failed: Number(/# fail (\d+)/.exec(testOutput)?.[1]), independentFractionOracleCases: oracle.length },
      directCalculation: stats(samples), localColossusHttp: stats(httpSamples), providerRequests,
      providerCostUsd: 0, cloudInfrastructureCost: 'not measured; no cloud resources were provisioned',
      example: { status: responseExample.claims[0].status, gap: responseExample.claims[0].gap },
      scope: 'Exact affine violation bounds for rectangular interval sets, or exact evaluation over explicitly supplied finite worlds. No external evidence authentication is performed.',
      empiricalValidation: 'Reviewed real-world labels and held-out process logs have not been evaluated.',
      quantumValidation: 'This is the classical reference model. A noncommuting quantum-inspired model and quantum advantage are not implemented or demonstrated.' };
    const dir = new URL('.local/christopher-validation/', root); await mkdir(dir, { recursive: true });
    await writeFile(new URL('test.tap', dir), testOutput); await writeFile(new URL('report.json', dir), JSON.stringify(result, null, 2) + '\n');
    await writeFile(new URL('example-response.json', dir), JSON.stringify(responseExample, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  } finally { await new Promise(resolve => { app.server.close(resolve); app.server.closeAllConnections(); }); }
}
