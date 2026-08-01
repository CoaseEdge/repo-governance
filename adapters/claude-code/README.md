# Claude Code adapter

`CLAUDE.md` and the seven prompt templates under `commands/` consume the same version-pinned CLI JSON and canonical Playbooks as the Codex adapter. `adapter-contract.json` declares the shared report version, command templates, consumed fields, and advisory classification labels used by cross-adapter tests.

Copy only the prompt templates you want into a repository's `.claude/commands/` directory. Do not copy rules into the prompt: each template reads the matching Playbook and delegates deterministic findings to `repo-governance`.

`architecture-review` explains the RG007 and architecture drift fields from one `repo-governance check --json` report. It does not calculate dependency rules, health scores, or replacement recommendations.

`hooks/settings.example.json` is an optional `SessionStart` and `PreToolUse(Edit|Write)` guardrail. Replace its absolute runner paths, merge the reviewed definitions into a trusted Claude Code settings file, and install it explicitly. The runner invokes only `repo-governance preflight --json`; only `status: "succeeded"` with `repoState: "managed"` permits a matched write. It never treats `ok` alone as authorization and never modifies `.claude/settings.json`.

`hooks/pre-commit.example` is a separate, explicitly installed Git pre-commit check. It delegates to the same preflight command and does not replace the repository's governed pre-push or `prepare-pr` checks.
