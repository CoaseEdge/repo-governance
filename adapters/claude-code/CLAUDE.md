# repo-governance for Claude Code

Use `repo-governance` as the only deterministic governance engine. Every Agent-facing invocation must request JSON, preserve `schemaVersion`, and explain the returned findings without recreating any RG rule or architecture drift calculation.

## Shared workflow

1. Before repository-changing work, run `repo-governance preflight --json` and read `../../playbooks/repo-governance-agent-gate.md`.
2. Continue repository writes only when `status` is `succeeded` and `repoState` is `managed`. `ok` only means that inspection completed.
3. Select the matching Playbook in `../../playbooks/`.
4. Run the exact CLI entry declared in `adapter-contract.json` with `--json`.
5. Treat CLI fields, findings, status, and next actions as facts.
6. Add only the advisory explanation allowed by the Playbook.

Never infer a Preset, compute rule findings, hash public commands, reconstruct workflow allowlists, guess test tiers from paths, or write GitHub state. Preserve `semanticCoverageVerified: false`: test-category evidence is not proof of semantic coverage.

The eight prompt templates under `commands/` map one-to-one to the shared Playbook IDs. They may be copied explicitly into a repository's `.claude/commands/` directory; the canonical templates remain version-locked with the installed engine assets. Optional Hook templates under `hooks/` must also be installed explicitly and never authorize remote writes.
