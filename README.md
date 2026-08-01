# repo-governance

[English](./README.md) | [简体中文](./README.zh-CN.md)

Deterministic repository governance shared by local Git hooks, CI, Codex, and Claude Code. The project is intentionally split into a hard, explainable CLI rule engine and thin advisory Agent adapters. The same version-pinned engine is used locally and in CI.

## Capability boundary

`RG001` verifies that a high-impact business change has same-change evidence in every configured companion test category. It does **not** prove that assertions cover the new semantics, that the implementation is correct, or that a test is high quality. Test execution, review, and `plan-change-test-impact` advice remain necessary.

## Development

Node.js 22 is required.

```sh
npm test
npm run check:static
```

## Source install

For local development or agent-assisted setup:

```sh
git clone https://github.com/CoaseEdge/repo-governance.git
cd repo-governance
npm ci
npm run install:local
```

This builds the local engine and self-contained version-aware launcher, installs them into the standard repo-governance data directory, and creates a managed bare-command entry at `~/.local/bin/repo-governance` (or the user-level Windows bin directory). The installer never edits a shell profile. When that bin directory is absent from the current `PATH`, installation reports `pathConfigured: false`, an `actionRequired` command that can be copied, and explicitly states that the entry exists but the bare command is not yet available in the current shell.

The installed pre-push hook is thin and offline. Its wrapper securely captures stdin, preserves an existing Hook as a verified sidecar, and invokes the stable launcher in the platform data directory. For every pushed tip, the launcher reads the candidate commit’s exact engine identity and `executionContractVersion`, verifies the locked executable, `prePushProtocolVersion`, and supported execution-contract versions, and then runs the dedicated isolated `repo-governance verify-execution --pre-push` path. It never falls back to mutable workspace configuration, a default engine, or the legacy `check` path. Missing protocol fields, incompatible versions, damaged candidate configuration, and missing or corrupt engines block execution.

## Agent preflight and automatic adoption policy

Before an Agent changes repository files, runs task tests, commits, or prepares a pull request, run:

```sh
repo-governance preflight --json
```

The command is offline and read-only. `ok` says whether inspection completed, `status` describes the workflow result, and `exitCode` is the shell-compatible `0`/`1`/`2` outcome; these fields are independent. Repository writes are allowed only when `status` is `succeeded` and `repoState` is `managed`. In particular, `ok: true` with `status: "needs_attention"` is not write permission.

An optional `~/.repo-governance-agent.json` can map normalized real path prefixes to explicit presets. Longest-prefix matching is deterministic, equal-priority conflicts block, and `autoBootstrap` can only waive repeated confirmation for `bootstrap` when a matching preset already exists. It never authorizes preset inference, `github enforce --confirm`, pull request creation, comments, ruleset changes, or other remote writes. See [Agent automatic adoption](docs/agent-auto-adoption.md) for the schema, lifecycle, and complete state examples.

The three gates have separate jobs: Agent preflight discovers whether work may start; the repository's offline Git pre-push hook defends every governed push; `prepare-pr` checks the clean committed change set before pull request work. Optional Codex and Claude Code lifecycle Hooks surface the preflight decision earlier, but are explicit trusted guardrails rather than a complete enforcement boundary.

RG006 validates the separately versioned execution contract: registered runtimes, exact package-manager identities, dependency preparation, lifecycle policy, ordered build/codegen/test stages, and declared consumers. Static checks never claim clean-checkout or semantic-coverage evidence. See [Execution contracts and RG006](docs/execution-contracts.md).

RG007 provides opt-in architecture governance through `.repo-governance/architecture-contract.json`. It deterministically scans JavaScript, TypeScript, and Python imports, builds file and explicit-module dependency graphs, blocks changed-path layer violations, and reports dependency cycles as non-blocking warnings. Architecture styles and external package meanings are defined only by the repository contract; the engine never calls an LLM or rewrites code. See [Architecture governance and RG007](docs/architecture-governance.md).

Architecture drift is separately enabled by committing `.repo-governance/architecture-baseline.json`. Use `repo-governance architecture baseline` to create the deterministic snapshot and `repo-governance architecture drift` to inspect metrics, added/removed facts, and the 0–100 health score. Scores below 70 block; warnings from 70–99 remain visible without failing the check. See [Architecture drift](docs/architecture-drift.md).

The v1.3 migration and release boundary is summarized in [v1.3 release](docs/v1.3-release.md).

Each protected workflow is linked only through its profile consumer and checks out the declared event revision with `clean: true`. The job may set up the declared runtime and restore an external package-download cache, but dependency installation, build, code generation, and tests belong to governed execution rather than independent workflow steps.

Pre-push canonical bases come only from the named push remote and its remote-tracking default branch; the Hook never fetches or substitutes a local branch. Every unique pushed tip/base pair runs in a detached local clone that cannot reuse source-workspace dependencies or ignored outputs. CI uses the exact event head/base SHAs and writes the base to `refs/repo-governance/base`.

## Quick Start for Existing Repositories

Install a verified, version-pinned release first, then run one explicit adoption command:

```sh
cd existing-repository
repo-governance bootstrap --preset node-library --json
```

`bootstrap` validates the selected static preset, writes `.repo-governance.json` and the thin GitHub Actions caller, composes the repository's effective pre-push hook, and runs an adoption check. It never overwrites existing governance configuration. Any failed adoption restores the previous Hook and removes files created by the attempt.

Available presets are `node-library`, `node-service`, `react-web`, `tauri-desktop`, and `python-service`. See [Preset reference](docs/presets.md) and [Adoption model](docs/adoption-model.md).

## Quick Start for New and Cloned Repositories

Use the explicit wrappers when you want repository creation or cloning and governance adoption to be one operation:

```sh
repo-governance new my-service --preset node-service --json
repo-governance clone https://example.com/team/project.git --preset node-service --json
```

`new` creates a governance-only Git repository, commits only the generated governance files, and runs the standard check. It does not generate application code. `clone` preserves the cloned history and leaves the generated governance files uncommitted for review. A clone, bootstrap, check, or Git identity failure removes only the target directory created by that invocation.

Native `git clone` and `git init` are never intercepted. Developers must use the explicit `repo-governance clone`, `new`, or `bootstrap` entry point to receive the combined flow. The CLI never guesses a preset, silently bootstraps a repository, or automatically writes GitHub state.

## Preparing a Pull Request

Run the deterministic PR preflight after committing all intended changes:

```sh
repo-governance prepare-pr --json
```

`prepare-pr` requires a clean worktree and projects the normal `check` result into RG001–RG005 groups, required test evidence, workflow findings, command-contract findings, and a Markdown PR body draft. It does not open a PR, call `gh`, comment, or write GitHub state. The report always preserves the RG001 boundary: companion test-category evidence does not prove semantic coverage.

## Manual initialization of a future repository

```sh
repo-governance init --json
# Review the detected candidates and define strict mappings.
repo-governance init --accept
```

Installation is future-only. `hooks install` configures a Git template but never scans or mutates existing repositories. Existing global `init.templateDir` configuration is preserved unless the user explicitly requests `--compose`; conflicting files stop composition. Repositories that use Husky or another `core.hooksPath` retain their existing pre-push commands and receive an appended dispatcher call.

The versioned configuration schema is in `schemas/repo-governance.schema.json`. Waivers live in `.repo-governance/waivers/*.json`, can apply only to `RG001`, exclude their own directory from the fixed business diff fingerprint, and never store a head SHA or approval state.

## Repository registry and engine pruning

Successful `bootstrap`, `new`, `clone`, and `update` commands register the canonical absolute repository path, its realpath at registration time, and locked engine identity in the user-level `repositories.json`. Registry updates use a process lock plus temporary-file atomic rename so concurrent writers do not lose records. `repositories register [path]`, `repositories list`, and `repositories unregister <path>` manage this explicit inventory. Unregister accepts a path that no longer exists; moved repositories must be registered again, and inaccessible registered paths continue to protect their engine until explicitly unregistered.

`engines list` reports verified installed engines and marks legacy or damaged metadata as `unknown`. `engines prune --dry-run` never deletes files; `engines prune --confirm` recomputes its plan from the current default pointer and registry before deletion. The default engine, every registered reference, every unknown engine, the latest installed usable engine, and one historical usable engine are protected. Output includes the estimated space and the safety boundary: absence from this explicit registry does not prove that no unregistered repository on the computer references an engine.

## Version advisory

`repo-governance version check` is the only version-advisory command that accesses the network. It downloads the historical catalog and detached Ed25519 signature from the canonical `CoaseEdge/repo-governance` GitHub release, validates every HTTPS redirect, verifies the pinned public key, rejects schema errors and rollback, then atomically caches the verified bytes. It reports advice only: it never downloads or installs an engine.

`preflight` never accesses the network and never writes advisory state. It reads and re-verifies the local cache and always includes `updateAdvisory` in JSON. Human preflight warns in yellow when the current engine is at least two published releases behind, or when any later release is marked as a security fix. One ordinary release behind does not warn. Git pre-push remains fully offline and never displays this advisory. Missing, damaged, and current-version-not-listed caches produce `missing`, `invalid`, and `current_unknown` status without blocking repository work. See [Signed release catalog](docs/release-catalog.md).

## Test tiers (RG002)

Executable test entries belong to exactly one of `pr-blocking`, `nightly`, or `manual-smoke`. Fixtures, mocks, helpers, setup modules, shared test utilities, and test data belong in `testSupport` and are not classified as standalone entries. A PR-blocking command may never reach a nightly or manual entry, even if that entry skips without a real secret.

The V1 command graph deliberately understands only `package.json` scripts, pnpm workspace/filter/run calls, Bun scripts, configured Python/pytest entries, and explicit aliases. Dynamic composition, `eval`, Makefile dispatch, opaque shell scripts, and unknown indirect calls in a protected chain are configuration errors; the engine does not guess.

## Workflow rule source (RG003)

Only jobs and steps explicitly registered as policy checks are hard-gated. Their registered steps must call an allowlisted central Action, CLI, or formal repository guard; unregistered `run` steps inside a formal policy job fail. Required guard files must exist and be reached through their exact configured entry.

Normal build, environment preparation, and artifact-processing jobs may use multiline scripts. The CLI does not use regex heuristics to decide whether arbitrary YAML “looks like” a duplicate secret, size, or hygiene check; advisory Skills may flag such code for review without turning it into a deterministic failure.

## Public command contracts (RG004)

Each team-confirmed public entry records its manifest, command name, exact definition SHA-256, semantics, test tier, and contract-test/documentation/workflow consumers. `pnpm test`, `check:static`, and `tauri:build` are initializer examples only, not hard-coded global commands.

Changing command text without updating its contract fails. Accepting new semantics also fails until the configured contract tests, documentation, and workflow consumers change in the same diff. This keeps a familiar command name from silently acquiring a different meaning.

## Using with Codex and Claude Code

Agent-neutral advisory knowledge lives in `playbooks/`. Seven thin Codex wrappers live in `adapters/codex/skills/`; Claude Code receives `CLAUDE.md` and seven matching prompt templates under `adapters/claude-code/commands/`. Both adapters declare the same CLI commands, JSON report version, Playbook IDs, consumed fields, and advisory labels. They invoke the version-pinned CLI and interpret its JSON rather than reimplementing hard rules or reading the user policy themselves. The shared `architecture-review` advisor explains RG007 and architecture drift fields from one `check --json` report without recalculating decisions or scores.

CI triage classifies a failure as `true-bug`, `stale-test`, `stale-workflow`, `wrong-ci-tier`, or `insufficient-evidence` before suggesting a fix. These are advisory labels; CLI RG findings remain the deterministic facts.

Release and local-source installation keep the canonical Playbooks and both adapter trees, including optional Hook templates, under the installed engine's version-locked `agent-assets/` directory. Codex Skills are also installed into `CODEX_HOME`; selected Claude templates can be copied explicitly into a repository's `.claude/commands/`. See [Agent adapters](docs/agent-adapters.md).

## GitHub enforcement and waiver approvals

Future repositories receive one thin `pull_request` caller pinned to the same full commit as `engineCommitSha`. The reusable workflow checks out the live untrusted head, fetches complete target history, computes merge-base itself, and runs the same CLI. It never uses `pull_request_target`. Core checks have only `contents: read` and `pull-requests: read`; optional comments run in a separate job that does not checkout or execute PR code.

Remote RG005 validation reads live reviews. The latest review by an allowed approver must be `APPROVED` and its `commit_id` must equal the live PR head SHA. Any later commit invalidates the approval, including a waiver-only commit; business changes also invalidate the fixed diff fingerprint.

`repo-governance github enforce` performs a read-only capability, permission, branch-protection, and ruleset preflight. Without `--confirm` it never writes. Missing administration permission or an active ruleset conflict returns `blocked`; a confirmed change is successful only after readback contains the required check.

## Release and installation

Release builds require Node.js 22.x and produce per-platform Node SEA executables for the CLI engine and version-aware launcher. The launcher is self-contained and does not require the governed repository's Node runtime. GitHub Releases publish one archive per platform (`.tar.gz` for Linux/macOS and `.zip` for Windows), plus top-level `SHA256SUMS`, `release-index.json`, deterministic `release-catalog.json`, and `release-catalog.sig`; GitHub Packages is not used. Each archive contains the CLI, launcher, seven Codex Skills, canonical Playbooks, Codex/Claude adapters and Hook templates, policy schemas including `agent-policy.schema.json`, an internal manifest, and platform-local checksums. Published artifacts include SHA-256 metadata and GitHub artifact attestations bound to `CoaseEdge/repo-governance`, `.github/workflows/release.yml`, the source commit, the platform archive, and the release manifest. The attested release manifest also binds deterministic Skill, policy-asset, and Agent-asset tree digests. Installation fails if either checksum or attestation verification fails; checksum alone is never accepted. The advisory catalog has a separate authenticity boundary: its fixed canonical source is the transferred `CoaseEdge/repo-governance` repository and it must verify against the single Ed25519 public key embedded in the executable.

Engine, launcher, default-pointer, and compatibility-dispatcher data uses `${XDG_DATA_HOME:-$HOME/.local/share}/repo-governance` on macOS/Linux and `%LOCALAPPDATA%/repo-governance` on Windows. POSIX launcher replacement and pointer updates use temporary files plus atomic rename. Windows launchers use versioned paths so an executing binary is never overwritten; the managed `.cmd` entry is switched only after verification and old locked files are left for later pruning. Skills use `${CODEX_HOME:-$HOME/.codex}/skills`. The optional shareable-index boundary is documented under `adapters/` and is never a public runtime dependency.
Deterministic repository governance for local hooks, CI, Codex, and Claude Code
