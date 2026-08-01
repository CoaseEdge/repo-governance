---
name: change-scope-review
description: Explain deterministic RG008 scope findings and task drift reports, and pause Agent work when the reported scope decision requires confirmation.
---

# Change Scope Review

1. Run `repo-governance check --json` in the repository and preserve its schema version.
2. Read [references/playbook.md](references/playbook.md); in the source repository, use `playbooks/change-scope-review.md`.
3. Consume only `mode`, `ok`, `exitCode`, `scopeFindings`, and `taskDrift` from the report.
4. Apply the Playbook's classification precedence and required Agent action.
5. Preserve every reported finding and drift field when explaining the decision.

Do not read the Task Contract directly, match paths, count files, interpret budgets, recalculate task drift, change severity, create a waiver, or modify repository files. Overall `ok` and `exitCode` may reflect other governance rules and are not scope evidence by themselves.
