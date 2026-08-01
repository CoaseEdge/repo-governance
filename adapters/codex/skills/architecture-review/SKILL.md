---
name: architecture-review
description: Explain deterministic architecture governance reports for repository changes without implementing architecture rules in the Agent adapter.
---

# Architecture Review

1. Run `repo-governance check --json` in the repository and preserve its schema version.
2. Read [references/playbook.md](references/playbook.md); in the source repository, use `playbooks/architecture-review.md`.
3. Explain only `architectureFindings`, `architectureGraph`, `architectureDriftFindings`, and `architectureDrift` according to the Playbook.
4. Separate deterministic conclusions and evidence from optional suggested actions, and state the capability boundary.

Do not add findings, change severity, recalculate dependency rules or health scores, resolve skipped evidence, or modify architecture files. A skipped report is not evidence of a healthy architecture.
