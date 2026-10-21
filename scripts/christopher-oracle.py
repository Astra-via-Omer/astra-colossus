"""Generate reproducible exact reference values with Python's Fraction.

The oracle enumerates box corners. Affine extrema occur at corners; for
absolute violation it also checks whether a segment between two corners
crosses zero. This is independent of the JS interval arithmetic path.
"""
from fractions import Fraction
from itertools import product
from pathlib import Path
import json, random

rng = random.Random(42102026)
cases = []
for i in range(600):
    ranges = [sorted([rng.randint(-6, 6), rng.randint(-6, 6)]) for _ in range(rng.randint(1, 3))]
    coefficients = [rng.randint(-4, 4) for _ in ranges]
    rhs = rng.randint(-8, 8)
    relation = ['<=', '>=', '=='][i % 3]
    values = [sum(Fraction(a) * x for a, x in zip(coefficients, vertex)) - rhs for vertex in product(*ranges)]
    if relation == '>=': values = [-v for v in values]
    violations = [abs(v) if relation == '==' else max(Fraction(0), v) for v in values]
    if relation == '==' and min(values) <= 0 <= max(values): violations.append(Fraction(0))
    assert all(v.denominator == 1 for v in violations)
    cases.append(dict(ranges=ranges, coefficients=coefficients, rhs=rhs, relation=relation, expected=[str(min(violations)), str(max(violations))]))
dest = Path(__file__).resolve().parents[1] / 'test/fixtures/christopher-oracle.json'
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text('[\n' + ',\n'.join(json.dumps(c, separators=(',', ':')) for c in cases) + '\n]\n')
print(f'Generated {len(cases)} exact reference cases: {dest}')
