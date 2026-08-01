# Review change scope governance

## CLI input

Run `repo-governance check --json` and preserve `schemaVersion`. Consume `mode`, `ok`, `exitCode`, `scopeFindings`, and `taskDrift` from that one report. The CLI is the only source of RG008 scope and drift decisions.

Treat a missing field, unsupported schema version, invalid severity, or malformed finding as `incompatible-input`. Do not reconstruct missing data from top-level `findings`, the Git diff, or the Task Contract.

## Classification precedence

Apply the first matching classification:

1. `incompatible-input`: required fields or the supported schema version are missing or incompatible. Stop before modifying the repository.
2. `not-evaluated`: `mode` is not `standard`. State that scope governance was not evaluated and do not infer a pass.
3. `blocked`: any `scopeFindings` entry has `severity: "error"`. Stop before modifying the repository.
4. `needs-confirmation`: any scope finding has `severity: "warning"`, or reported task drift severity is `medium` or `high`. Pause repository modifications and ask the user to confirm the declared scope before continuing.
5. `advisory`: there are no scope findings and reported task drift severity is `low`. Explain the drift evidence and continue only within the user's existing authorization.
6. `no-scope-signal`: there are no scope findings and reported task drift severity is `none`. This neutral report does not prove that a Task Contract exists or that the task is in scope.

Never use `ok` or `exitCode` to override this order. They describe the overall check and may reflect findings unrelated to RG008.

## Evidence and action

Preserve each finding's `rule`, `type`, optional `path`, optional budget fields, `severity`, `message`, and `waivable` value. Preserve `taskDrift.taskDriftScore`, `taskDrift.severity`, and every reported reason. Do not add findings, change severity, reinterpret a budget, or calculate a different drift score.

Organize the response as:

1. **Scope decision**: the classification and required Agent action.
2. **Scope findings**: the reported types, paths or budget evidence, severity, messages, and waiver status.
3. **Task drift**: the reported score, severity, and reasons.
4. **Overall check**: `ok` and `exitCode`, clearly separated from the scope decision.
5. **Capability boundary**: state that the Agent explained the deterministic report without recomputing or overriding it.

This Playbook never authorizes editing the Task Contract, changing source code, creating a waiver, or widening the task. Repository modifications still require the user's request and normal governance checks.

## Example

Given a standard report with an `OUT_OF_SCOPE_CHANGE` warning and medium task drift, return `needs-confirmation`, preserve the reported path and drift reasons, and pause modifications until the user confirms the declared scope. Do not treat a successful overall check as permission to continue.
