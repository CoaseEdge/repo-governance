# Task failure baseline tracking

AI coding agents need to distinguish failures caused by the current task from failures that already existed. Without an explicit baseline, an agent can expand a small task into unrelated historical cleanup. The task failure baseline records observed test failures at task start and later classifies the current result without deciding what to fix.

## Test result contract

The CLI consumes a JSON file supplied with `--results`. It never starts a test runner. Each suite contains stable failure identifiers:

```json
{
  "schemaVersion": 1,
  "tests": {
    "playwright": {
      "failed": ["auth.spec.ts"]
    }
  }
}
```

Suite identifiers and failure values must be unique and valid. Unknown fields, duplicate failures, empty strings, and malformed JSON are rejected. Suites and failures are normalized in UTF-8 byte order.

## Create a baseline

Create the baseline before making task changes. `createdAt` is explicit and must use the canonical UTC form produced by `Date.prototype.toISOString()`; the engine never reads the system clock.

```sh
repo-governance baseline create \
  --results /tmp/test-results.json \
  --created-at 2026-08-01T09:30:00.000Z \
  --json
```

The command atomically writes `.repo-governance/task-baseline.json`. Existing baselines are preserved unless `--replace` is explicitly supplied.

## Compare current failures

After running tests outside repo-governance, compare another result file:

```sh
repo-governance baseline compare --results /tmp/current-results.json --json
```

The report contains three deterministic arrays. Each entry has `suite` and `test` fields:

- `newFailures`: present now but absent from the baseline.
- `existingFailures`: present in both inputs.
- `fixedFailures`: present in the baseline but absent now.

The comparison is classification only. New failures do not change `ok` or `exitCode`, do not create RG008 findings, and do not enter the standard repository check. The engine does not run tests, call an LLM, access the network, modify source files, or automatically fix any failure. Enforcement and Agent policy belong to later changes.
