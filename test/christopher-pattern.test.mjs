import test from 'node:test';
import assert from 'node:assert/strict';
import { patternInput, publicLogCase } from '../src/christopher-pattern.js';
import { fingerprint } from '../src/christopherFingerprint.mjs';
test('published record and explicit assumptions remain distinct from counterfactual comparisons', async () => {
  assert.equal(publicLogCase.approval, publicLogCase.activation);
  const expectations = { recorded: ['matching', '0', '0'], uncertain: ['uncertain', '0', '2'], late: ['conflicting', '60', '60'], missing: ['missing'], different: ['incomparable'] };
  for (const [mode, [status, lower, upper]] of Object.entries(expectations)) {
    const input = patternInput(mode), result = await fingerprint(input), f = result.fingerprint.features[0];
    assert.equal(f.status, status, mode);
    if (lower) assert.deepEqual(f.gap, { lower, upper, unit: 'second' }); else assert.equal(f.gap, null);
    if (mode === 'different') assert.equal(result.fingerprint.excluded[0].reason, 'scope_mismatch');
    if (['late', 'missing', 'different'].includes(mode)) assert(input.observations.every(o => o.sourceId.startsWith('counterfactual')));
    assert.equal(new Set(input.observations.map(o => o.sourceGroup)).size, 1);
  }
  assert.throws(() => patternInput('fabricated-score'));
});
