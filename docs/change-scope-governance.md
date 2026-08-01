# Change scope governance and RG008

AI coding agents can continue making locally reasonable changes after a task has drifted away from its original objective. A task contract records the intended scope before implementation begins, so later governance stages can compare observed changes with a human-declared boundary instead of asking an LLM to infer intent.

## Task contract

Place the optional task contract at `.repo-governance/task-contract.json`:

```json
{
  "schemaVersion": 1,
  "taskId": "plan-69-75",
  "objective": "Implement Plan lifecycle support",
  "allowedPaths": [
    "src/runtime/plan/**",
    "src/desktop/runtime/**"
  ],
  "forbiddenPaths": [
    "src/admin/**"
  ],
  "migrationPaths": [
    "migrations/**"
  ],
  "allowedChangeCategories": [
    "source-code",
    "tests"
  ],
  "drift": {
    "subsystems": [
      {
        "id": "admin",
        "paths": ["src/admin/**"]
      }
    ],
    "sharedPaths": ["src/shared/**"],
    "ciReleasePaths": [".github/workflows/**", "scripts/release/**"]
  },
  "budget": {
    "maxFiles": 30,
    "maxDirectories": 5,
    "maxMigrations": 2,
    "maxOutOfScopeFiles": 0
  }
}
```

`taskId` is a stable identifier and `objective` is the human-authored result the task should achieve. Path patterns are repository-relative POSIX globs. `allowedPaths` must contain at least one pattern; `forbiddenPaths` and `migrationPaths` may be empty. `allowedChangeCategories` is optional and defaults to an empty array. Category names are repository-declared lowercase identifiers: the engine does not assign built-in meaning to them.

The optional `drift` object declares how the repository recognizes subsystem, shared-module, and CI/release changes. Subsystems have stable lowercase IDs and one or more explicit path patterns. Missing declarations normalize to empty arrays. The engine does not infer these categories from directory names, framework conventions, or an LLM.

`maxFiles` remains required and positive. `maxDirectories`, `maxMigrations`, and `maxOutOfScopeFiles` are optional non-negative limits, so existing version 1 contracts remain valid. When `maxMigrations` is declared, `migrationPaths` must explicitly identify migration files; the engine never guesses from framework conventions. Direct parent directories are counted once, with repository-root files assigned to `.`. Forbidden files are counted separately and do not consume the out-of-scope allowance.

The loader is deterministic and offline. It reads the fixed path, rejects unknown fields, unsafe paths, duplicates, invalid identifiers, and unsupported schema versions, and returns arrays in a stable order. A missing contract returns `null`, allowing repositories and tasks that have not adopted change scope governance to remain compatible.

## Task contract versus architecture contract

A task contract is short-lived and specific to one objective. It describes where one task may make changes and how large that change is expected to be. Different tasks in the same repository can use different task contracts.

An architecture contract is long-lived repository policy. It describes layers, modules, and permitted dependency directions regardless of which task is active. A change can stay inside its task contract while violating the architecture contract, or satisfy the architecture contract while expanding beyond its declared task scope. The contracts answer different questions and neither replaces the other.

## Scope diff analyzer

Standard repository checks compare the changed paths with the optional task contract and expose the result as `scopeFindings`. The same RG008 entries are appended to the existing top-level `findings` array. All entries are deterministic and non-waivable.

RG008 reports three finding types:

- `FORBIDDEN_PATH` when a changed file matches `forbiddenPaths`;
- `OUT_OF_SCOPE_CHANGE` when a changed file does not match `allowedPaths`;
- `BUDGET_EXCEEDED` when any declared file, directory, migration, or out-of-scope budget is exceeded.

Forbidden paths take precedence, so one changed file produces at most one path finding. `.repo-governance/task-contract.json` is governance metadata and is excluded from path findings and every budget. Path findings use stable repository-path order, followed by budget findings in contract-field order. Adoption checks skip task scope analysis because a repository snapshot is not an individual task diff.

## Task drift score

Standard checks also expose a `taskDrift` object with `taskDriftScore`, `severity`, and deterministic `reasons`. The score starts at zero and adds:

- 5 for each non-forbidden file outside `allowedPaths`;
- 10 for each unique declared subsystem touched outside `allowedPaths`;
- 5 for each file matching `drift.sharedPaths`;
- 10 for each file matching `drift.ciReleasePaths`;
- 15 for each file matching `migrationPaths` outside `allowedPaths`.

Evidence is unique and rules are additive, so one path may contribute to more than one declared category. Subsystems count once by ID even when several files match. Reasons use fixed category order and UTF-8 path or ID order. The score is not capped. Severity is `none` at 0, `low` from 1–14, `medium` from 15–29, and `high` from 30 upward. The task contract file is excluded. Missing contracts and adoption checks return the neutral result `{ "taskDriftScore": 0, "severity": "none", "reasons": [] }`.

Task drift is advisory only. It does not emit a finding, change `ok` or `exitCode`, or weaken blocking forbidden-path and budget findings.

## Agent scope review

The shared `change-scope-review` Playbook and its thin Codex and Claude Code adapters explain the deterministic `check --json` report. They consume only `mode`, `ok`, `exitCode`, `scopeFindings`, and `taskDrift`, preserving reported finding types, paths, budget evidence, severity, messages, waiver status, score, severity, and reasons.

The adapters apply a fixed precedence: incompatible input, non-standard mode, blocking RG008 errors, warnings or medium/high drift that require user confirmation, low-drift advisory, then a neutral no-scope-signal result. A neutral result does not prove that a Task Contract exists or that the task is in scope. Overall `ok` and `exitCode` are shown separately because other governance rules can determine them.

The Agent stops before repository changes for blocking or incompatible reports and pauses for user confirmation when scope warnings or medium/high drift are reported. It never reads the Task Contract directly, recalculates paths, budgets, or drift, creates a waiver, expands the task, or modifies files on the report's authority alone.

## Enforcement boundary

`FORBIDDEN_PATH` and `BUDGET_EXCEEDED` are errors that block the check. Individual `OUT_OF_SCOPE_CHANGE` entries remain warnings when they fit within `maxOutOfScopeFiles`; exceeding that allowance adds a blocking budget error. The engine does not interpret `allowedChangeCategories`, apply waivers, call an LLM, access the network, or modify source code. Agent adapters only explain this deterministic output and cannot override the enforcement boundary.
