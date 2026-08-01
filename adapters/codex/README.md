# Codex adapter

The Skills under `skills/` are thin wrappers around version-pinned repo-governance CLI JSON. Detailed advisory workflows live only in the repository-level `playbooks/` directory.

Release and local-source packaging copy each canonical Playbook into the installed Skill as `references/playbook.md`. This keeps the source of truth shared while preserving the standard self-contained installed Skill layout.

`architecture-review` explains the RG007 and architecture drift fields from one `repo-governance check --json` report. It preserves deterministic findings, graph status, health scores, penalties, and recommendations; it never recalculates or overrides them.

`repo-governance-agent-gate` runs the read-only `preflight --json` contract before repository-changing work and permits writes only for `status: "succeeded"` with `repoState: "managed"`. The optional templates under `hooks/` use Codex `SessionStart` and `PreToolUse(Edit|Write)` only to surface or enforce that CLI decision. Copy and edit `hooks.example.json` explicitly, replace the runner path, then review and trust the exact definitions in Codex. Nothing in this adapter modifies `.codex/config.toml`, installs Hooks, or bypasses Hook trust.
