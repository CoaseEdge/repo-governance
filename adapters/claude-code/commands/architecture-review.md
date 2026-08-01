# Architecture review

Playbook ID: `architecture-review`

Canonical Playbook: `../../../playbooks/architecture-review.md`

Run `repo-governance check --json` and preserve its schema version. Explain only the returned `architectureFindings`, `architectureGraph`, `architectureDriftFindings`, and `architectureDrift` according to the canonical Playbook.

Keep deterministic conclusions, evidence, suggested actions, and the capability boundary separate. Do not add findings, change severity, recalculate rules or health scores, resolve skipped evidence, or modify architecture files. Treat `status: "skipped"` as not evaluated, never as healthy.
