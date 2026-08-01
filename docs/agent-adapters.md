# Agent adapters / Agent 适配层

## Shared contract

The repo-governance CLI is the only deterministic rule engine. Codex and Claude Code use the same `schemaVersion: 1` reports, canonical Playbook IDs, command templates, consumed fields, and advisory classification labels. The machine-readable declarations are:

- `adapters/codex/adapter-contract.json`
- `adapters/claude-code/adapter-contract.json`

Cross-adapter tests remove only the adapter name and require the remaining declarations to be identical. They also feed both declarations the same report fixtures. This verifies structured inputs and boundaries; it does not claim two language models will produce word-for-word identical prose.

| Playbook ID | CLI fact source | Adapter output |
|---|---|---|
| `repo-governance-agent-gate` | `preflight --json`, then `prepare-pr --json` before PR work | Structured start/write decision and next action |
| `bootstrap-repo-governance` | `bootstrap/new/clone --json` | Adoption explanation and next actions |
| `plan-change-test-impact` | `prepare-pr --json` or explicit `check --json` | Concrete companion-test advice |
| `classify-test-tier` | `check --json` RG002 plus operating evidence | One advisory tier |
| `protect-public-commands` | `prepare-pr --json` RG004 projection | Synchronized consumer advice |
| `triage-ci-failure` | `check --json` plus CI evidence | One advisory failure label |
| `architecture-review` | `check --json` RG007 and architecture drift fields | Evidence-backed architecture explanation and suggestions |
| `change-scope-review` | `check --json` RG008 scope findings and task drift | Scope decision, evidence, and required Agent pause |

Codex releases install the eight self-contained Skills into `${CODEX_HOME:-$HOME/.codex}/skills`. Claude Code assets remain version-locked under the installed engine:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/repo-governance/
  engines/<engineCommitSha>/agent-assets/
    playbooks/
    adapters/claude-code/
```

To expose a Claude prompt template in one repository, copy the selected Markdown file from `agent-assets/adapters/claude-code/commands/` into that repository's `.claude/commands/` directory. Optional Claude `SessionStart` and `PreToolUse(Edit|Write)` definitions are in `hooks/settings.example.json`; the separate `pre-commit.example` delegates to preflight. Replace absolute paths, review the exact definitions, and install them explicitly. Nothing modifies `.claude/settings.json` automatically.

`change-scope-review` consumes only `mode`, `ok`, `exitCode`, `scopeFindings`, and `taskDrift` from one `check --json` report. It uses the shared fixed precedence to classify the report as `blocked`, `needs-confirmation`, `advisory`, `no-scope-signal`, `not-evaluated`, or `incompatible-input`. It stops on errors and pauses for user confirmation on warnings or medium/high drift without reading the Task Contract or recalculating paths, budgets, or scores.

Codex provides equivalent optional templates under `adapters/codex/hooks/`. Both runners invoke only `repo-governance preflight --json`. They permit a matched write only when `status` is `succeeded` and `repoState` is `managed`; `ok` alone is never authorization. Keep `CLAUDE.md`, both contracts, and canonical Playbooks available from the same locked asset tree. Agent wrappers must not read `~/.repo-governance-agent.json`, infer a Preset, recreate path matching or command hashes, silently write GitHub state, or claim test evidence proves semantic coverage.

These lifecycle Hooks are trusted convenience guardrails, not the repository enforcement boundary. Agent preflight decides whether work may begin, the offline Git pre-push Hook defends pushes, and `prepare-pr` evaluates the final clean committed change set.

## 共享契约

repo-governance CLI 是唯一的确定性规则引擎。Codex 与 Claude Code 使用相同的 `schemaVersion: 1` 报告、规范 Playbook ID、命令模板、消费字段和建议分类标签。跨适配测试只忽略适配器名称，要求其余声明完全一致，并让两份声明消费同一组报告 fixture。该测试验证结构化输入和能力边界，不声称两个语言模型会生成逐字一致的自然语言。

Codex release 会把八个自包含 Skill 安装到 `${CODEX_HOME:-$HOME/.codex}/skills`。Claude Code 的 `CLAUDE.md`、命令模板、可选 Hook 模板和两边共享的 Playbook 则保存在引擎目录的 `agent-assets/` 下，并由同一个 release manifest 摘要与 `engineCommitSha` 锁定。

`architecture-review` 只解释同一份 `check --json` 中的 RG007 与架构漂移字段。它保留 finding、图状态、健康分、处罚和固定建议，不重新计算依赖规则或分数；`skipped` 表示未评估，不能解释为架构健康。

`change-scope-review` 只消费同一份 `check --json` 中的 `mode`、`ok`、`exitCode`、`scopeFindings` 与 `taskDrift`。它按固定优先级给出 `blocked`、`needs-confirmation`、`advisory`、`no-scope-signal`、`not-evaluated` 或 `incompatible-input`，并在错误时停止、在 warning 或中高漂移时暂停等待用户确认。它不读取 Task Contract，也不重新匹配路径、计算预算或漂移分数。

如需在某个仓库启用 Claude 命令，把锁定资产中的指定命令 Markdown 复制到该仓库的 `.claude/commands/`。`hooks/settings.example.json` 提供 `SessionStart` 与 `PreToolUse(Edit|Write)` 示例，`pre-commit.example` 提供独立提交前检查；替换绝对路径、审阅定义后再显式安装，工具绝不会自动修改 `.claude/settings.json`。Codex 提供等价的可选 Hook 模板。

两套 runner 都只调用 `repo-governance preflight --json`。只有 `status: "succeeded"` 与 `repoState: "managed"` 同时成立时才允许匹配的写入，不能单独依据 `ok`。Wrapper 不得读取 `~/.repo-governance-agent.json`、猜 Preset、重做路径匹配或命令哈希、静默写 GitHub，也不得把测试类别证据说成语义覆盖已经验证。生命周期 Hook 只是可信的前置加固：Agent preflight 判断能否开始，离线 Git pre-push 防守 push，`prepare-pr` 检查最终干净提交集。
