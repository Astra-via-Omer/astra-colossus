"""Independently verify test calculations with Python's exact Fraction type.

Reads [{input, result}] from stdin. This offline test utility authenticates no
external evidence and is not a serving endpoint.
"""
import json
import sys
from fractions import Fraction as F


def verify(item):
    request, result = item["input"], item["result"]
    variables = {v["id"]: v for v in request["variables"]}
    definitions = {c["id"]: c for c in request["claims"]}
    bounds = {i: (F(str(v["domain"]["min"])), F(str(v["domain"]["max"]))) for i, v in variables.items()}
    for observation in request["observations"]:
        i = observation["variableId"]
        a, b = bounds[i]
        bounds[i] = (max(a, F(str(observation["interval"]["min"]))), min(b, F(str(observation["interval"]["max"]))))

    def residual(claim, values):
        r = sum((F(str(t["coefficient"])) * values[t["variableId"]] for t in claim["terms"]), F(0)) - F(str(claim["rhs"]))
        return -r if claim["relation"] == ">=" else r

    def violation(claim, values):
        if claim["kind"] == "linear":
            r = residual(claim, values)
            return abs(r) if claim["relation"] == "==" else max(F(0), r)
        truths = [violation(definitions[i], values) == 0 for i in claim["claimIds"]]
        return F(0 if (all(truths) if claim["kind"] == "all" else any(truths)) else 1)

    def number(value):
        assert int(value["denominator"]) > 0
        return F(int(value["numerator"]), int(value["denominator"]))

    worlds = {w["id"]: {i: F(str(v)) for i, v in w["values"].items()} for w in request.get("worlds", [])}
    compatible = {i: values for i, values in worlds.items() if all(a <= values[v] <= b for v, (a, b) in bounds.items())}
    for claim in result["claims"]:
        if claim["gap"] is None:
            assert claim["mathematics"]["status"] == "not_calculated"
            assert "witnesses" not in claim["mathematics"]
            continue
        definition = definitions[claim["id"]]
        witnesses = claim["mathematics"]["witnesses"]
        for name, witness in witnesses.items():
            values = {i: number(v) for i, v in witness["values"].items()}
            assert set(values) == set(variables)
            assert all(a <= values[i] <= b for i, (a, b) in bounds.items()), (claim["id"], name, "infeasible witness")
            if worlds:
                assert values == compatible[witness["worldId"]]
            if definition["kind"] == "linear":
                assert residual(definition, values) == number(witness["residual"])
            else:
                assert witness["residual"] is None
            actual = violation(definition, values)
            assert actual == number(witness["violation"]) == F(claim["gap"][name]), (claim["id"], name, "wrong witness value")
        if worlds:
            violations = [violation(definition, values) for values in compatible.values()]
            expected = (min(violations), max(violations))
        else:
            # Combine repeated coefficients before independently finding extrema.
            coefficients = {i: sum((F(str(t["coefficient"])) for t in definition["terms"] if t["variableId"] == i), F(0)) for i in variables}
            a = sum((min(coefficient * bounds[i][0], coefficient * bounds[i][1]) for i, coefficient in coefficients.items()), F(0)) - F(str(definition["rhs"]))
            b = sum((max(coefficient * bounds[i][0], coefficient * bounds[i][1]) for i, coefficient in coefficients.items()), F(0)) - F(str(definition["rhs"]))
            if definition["relation"] == ">=":
                a, b = -b, -a
            assert (F(claim["orientedResidual"]["min"]), F(claim["orientedResidual"]["max"])) == (a, b)
            expected = ((F(0) if a <= 0 <= b else min(abs(a), abs(b))), max(abs(a), abs(b))) if definition["relation"] == "==" else (max(F(0), a), max(F(0), b))
        assert (F(claim["gap"]["lower"]), F(claim["gap"]["upper"])) == expected


items = json.load(sys.stdin)
for index, item in enumerate(items):
    try:
        verify(item)
    except Exception as error:
        raise AssertionError(f"Calculation {index}: {error}") from error
print(json.dumps({"verifiedCalculations": len(items)}))
