# Review architecture governance

## CLI input

Run `repo-governance check --json` and preserve `schemaVersion`. The CLI is the only source of architecture decisions. Consume `architectureFindings`, `architectureGraph`, `architectureDriftFindings`, and `architectureDrift` from that one report. If any field is absent, report an incompatible or incomplete input instead of reconstructing it.

## Interpretation

For each RG007 finding, preserve its `code`, `severity`, `waivable`, `file`, source and target ownership, and import evidence. Explain dependency errors separately from file or explicit-module cycle warnings. Never promote a warning to an error, add a finding, infer an undeclared module, resolve skipped imports, or decide that a different dependency direction should have been allowed.

For architecture drift, quote the reported baseline and current health, classification, fact changes, penalties, and recommendations without recalculating them. `status: "skipped"` means that drift was not evaluated because its prerequisite was absent; it never means the architecture is healthy. A skipped architecture graph likewise means RG007 was not evaluated, not that the repository has no violations.

An evaluated report with no architecture findings means only that the deterministic check reported none for its configured scope. It does not prove runtime dependency direction, semantic design quality, or correctness beyond the static scanner's documented capability.

## Advisory response

Organize the explanation as:

1. **Deterministic conclusion**: the CLI status, finding code, and severity.
2. **Evidence**: the reported file, source and target boundary, import syntax and specifier, cycle nodes, or drift facts.
3. **Contract impact**: restate what the report says is forbidden, not allowed, cyclic, or drifting.
4. **Suggested action**: offer a conditional, reviewable option tied to that evidence.
5. **Capability boundary**: state that the suggestion is advisory and that the Agent did not recompute or override governance.

Suggestions may describe common refactoring directions, but they must not be presented as contract requirements unless the report says so. Do not move files, rewrite imports, replace a baseline, edit the architecture contract, or otherwise apply a suggested change without a separate user request and normal repository governance.

## Example

Given an RG007 report showing `src/domain/payment.js` in the domain layer importing a database target in the infrastructure layer, an Advisor may return:

> **Deterministic conclusion:** RG007 reports `forbidden-dependency` with error severity.
>
> **Evidence:** `src/domain/payment.js` imports `../infrastructure/database.js`; the report identifies the source as domain and the target as infrastructure/database.
>
> **Contract impact:** The reported dependency crosses a boundary forbidden by the repository architecture contract.
>
> **Suggested action:** Consider introducing or reusing a domain-owned repository interface and keeping its database implementation in infrastructure.
>
> **Capability boundary:** This refactoring direction is a suggestion for review, not a new finding or an inferred contract rule. The Advisor did not change the repository.
