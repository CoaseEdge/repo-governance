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
  "allowedChangeCategories": [
    "source-code",
    "tests"
  ],
  "budget": {
    "maxFiles": 30
  }
}
```

`taskId` is a stable identifier and `objective` is the human-authored result the task should achieve. Path patterns are repository-relative POSIX globs. `allowedPaths` must contain at least one pattern; `forbiddenPaths` may be empty. `allowedChangeCategories` is optional and defaults to an empty array. Category names are repository-declared lowercase identifiers: this foundation does not assign built-in meaning to them. The version 1 budget declares one positive `maxFiles` limit.

The loader is deterministic and offline. It reads the fixed path, rejects unknown fields, unsafe paths, duplicates, invalid identifiers, and unsupported schema versions, and returns arrays in a stable order. A missing contract returns `null`, allowing repositories and tasks that have not adopted change scope governance to remain compatible.

## Task contract versus architecture contract

A task contract is short-lived and specific to one objective. It describes where one task may make changes and how large that change is expected to be. Different tasks in the same repository can use different task contracts.

An architecture contract is long-lived repository policy. It describes layers, modules, and permitted dependency directions regardless of which task is active. A change can stay inside its task contract while violating the architecture contract, or satisfy the architecture contract while expanding beyond its declared task scope. The contracts answer different questions and neither replaces the other.

## Scope diff analyzer

Standard repository checks compare the changed paths with the optional task contract and expose the result as `scopeFindings`. The same RG008 entries are appended to the existing top-level `findings` array. They are deterministic, non-waivable warnings: they do not change `ok` or `exitCode`.

RG008 reports three finding types:

- `FORBIDDEN_PATH` when a changed file matches `forbiddenPaths`;
- `OUT_OF_SCOPE_CHANGE` when a changed file does not match `allowedPaths`;
- `BUDGET_EXCEEDED` when the number of unique changed files exceeds `budget.maxFiles`.

Forbidden paths take precedence, so one changed file produces at most one path finding. `.repo-governance/task-contract.json` is governance metadata and is excluded from path findings and the file budget. Path findings use stable repository-path order, followed by the optional budget finding. Adoption checks skip task scope analysis because a repository snapshot is not an individual task diff.

## Advisory boundary

The analyzer reports observed path and file-count facts only. It does not interpret `allowedChangeCategories`, block changes, apply waivers, call an LLM, access the network, or modify source code. Enforcement and Agent integration belong to later RG008 changes.
