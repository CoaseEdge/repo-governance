# Architecture drift

Architecture drift compares the current deterministic RG007 graph with a repository-owned baseline. It is opt-in twice: the repository must have both `.repo-governance/architecture-contract.json` and `.repo-governance/architecture-baseline.json`. A contract without a baseline keeps RG007 active while drift reporting remains `status: "skipped"`.

## Create and inspect a baseline

Create the baseline only after reviewing the repository's current architecture:

```sh
repo-governance architecture baseline --json
repo-governance architecture drift --json
```

The baseline command refuses to overwrite an existing file. Resetting accepted architecture requires an explicit command:

```sh
repo-governance architecture baseline --replace --json
```

Baseline writes use a temporary file and atomic rename. The version 1 file contains the normalized contract SHA-256, graph SHA-256, a starting health score of 100, the complete architecture graph, metrics, and sorted facts. It has no timestamp, host path, or environment-specific field, so identical repository and contract bytes produce identical baseline bytes. The baseline file itself and the architecture contract are excluded from scanned graph inputs.

The engine validates the baseline structure, graph digest, derived metrics, derived facts, and normalized contract digest before comparison. Removing an active baseline in the evaluated diff, corrupting it, or changing the contract without explicitly replacing the baseline fails closed with `RG_ARCHITECTURE_BASELINE` and exit code 2. This prevents drift governance from being silently disabled or compared across incompatible contracts.

## Metrics and facts

The report records current, baseline, and delta values for:

- scanned file count and explicit path-backed module count;
- unique cross-layer dependencies;
- unique explicit-module dependencies and their import evidence;
- file cycles and explicit-module cycles;
- architecture boundary violations;
- average coupling.

Average coupling is the number of unique explicit-module dependency edges divided by the number of explicit path-backed modules, rounded to three decimal places. It is zero when no path-backed module is declared. Contract-mapped external targets can contribute dependency edges, but they never increase the denominator.

The complete graph is compared to the baseline. Additions and removals are separately sorted in the report, so removals remain visible without being treated as degradation. RG007 continues to apply its changed-path rule independently: architecture drift describes movement from the accepted baseline, while RG007 identifies contract violations introduced or touched by the current change.

## Health score and enforcement

Every baseline starts at 100. Only facts added since that baseline reduce the current score:

| Added fact | Penalty | Cap |
| --- | ---: | ---: |
| Boundary violation | 10 each | 40 |
| File or explicit-module cycle | 5 each | 25 |
| Cross-layer dependency | 4 each | 20 |
| Explicit-module dependency | 1 each | 15 |

The score is `max(0, 100 - total penalties)`. Classifications and check behavior are fixed:

- `100`: Healthy, no drift finding.
- `90–99`: Minor drift, non-blocking warning.
- `70–89`: Needs attention, non-blocking warning.
- `0–69`: Architecture degradation, blocking error and exit code 1.

Drift findings use `rule: "ARCHITECTURE_DRIFT"`, are never waivable, and are appended to the existing top-level `findings`. `repo-governance check --json` also exposes `architectureDriftFindings` and `architectureDrift` without removing or renaming older fields. Fixed recommendation templates correspond only to observed fact categories; they do not decide architecture policy.

## Enforcement boundary

Drift calculation is deterministic, offline, and uses the same static RG007 graph as local checks and CI. It does not call an LLM, access the network, emit telemetry, infer undeclared modules, or guess unresolved imports. It detects and reports change; it never moves files, rewrites imports, updates the contract, or replaces a baseline automatically. Agent advisors may explain the structured report, but they must not recalculate findings or override the score.
