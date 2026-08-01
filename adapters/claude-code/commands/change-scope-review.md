# Change scope review

Playbook ID: `change-scope-review`

Canonical Playbook: `../../../playbooks/change-scope-review.md`

Run `repo-governance check --json` and preserve its schema version. Consume only `mode`, `ok`, `exitCode`, `scopeFindings`, and `taskDrift`, then apply the canonical Playbook's classification precedence and required Agent action.

Preserve reported finding and drift evidence. Do not read the Task Contract directly, match paths, count files, interpret budgets, recalculate task drift, change severity, create a waiver, or modify repository files. Overall check status is not scope evidence by itself.
