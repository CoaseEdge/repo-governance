# repo-governance

[English](./README.md) · [简体中文](./README.zh-CN.md)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./docs/assets/readme/hero-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="./docs/assets/readme/hero-light.svg">
  <img alt="repo-governance 将本地 Git Hooks、CI、Codex 与 Claude Code 连接到同一个确定性治理引擎" src="./docs/assets/readme/hero-light.svg">
</picture>

<p align="center"><strong>让本地 Git Hooks、CI、Codex 与 Claude Code 执行同一套版本锁定的仓库治理规则。</strong></p>

<p align="center">
  <a href="https://github.com/CoaseEdge/repo-governance/actions/workflows/ci.yml"><img alt="CI 状态" src="https://img.shields.io/github/actions/workflow/status/CoaseEdge/repo-governance/ci.yml?branch=main&amp;style=flat-square&amp;label=CI"></a>
  <a href="https://github.com/CoaseEdge/repo-governance/actions/workflows/repo-governance.yml"><img alt="Repo Governance 状态" src="https://img.shields.io/github/actions/workflow/status/CoaseEdge/repo-governance/repo-governance.yml?style=flat-square&amp;label=governance"></a>
  <a href="https://github.com/CoaseEdge/repo-governance/releases/latest"><img alt="最新版本" src="https://img.shields.io/github/v/release/CoaseEdge/repo-governance?sort=semver&amp;style=flat-square"></a>
  <a href="./package.json"><img alt="Node.js 22.x" src="https://img.shields.io/badge/Node.js-22.x-339933?logo=node.js&amp;logoColor=white&amp;style=flat-square"></a>
  <a href="./LICENSE"><img alt="MIT 许可证" src="https://img.shields.io/github/license/CoaseEdge/repo-governance?style=flat-square"></a>
  <img alt="支持 Linux、macOS 和 Windows" src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-475569?style=flat-square">
</p>

`repo-governance` 把仓库策略转化为确定、可解释的检查。开发者、编码 Agent、Git Hooks 与 GitHub Actions 共同使用同一个锁定版本的引擎，不需要让每个集成各自重新解释策略。

关键推送门禁完全离线。引擎不会让 LLM 作出硬性判定，不会根据代码语义猜测风险，不会改写源码，也不会宣称任务已经完成。

## 为什么使用 repo-governance

| 单一规则源 | 比例工程 | 可验证证据 |
| --- | --- | --- |
| 本地 Hooks、CI、Codex 与 Claude Code 使用同一份稳定 JSON 契约。 | 任务范围、变更类别、复杂度预算与风险区让验证成本与改动规模相匹配。 | 版本锁定引擎、精确 revision、隔离执行与当前 diff 测试证据让结果可复现。 |

## 工作原理

![从只读预检、任务契约、仓库检查，到隔离 pre-push 验证与 CI 的治理流程](./docs/assets/readme/governance-flow.svg)

三层门禁各自承担不同职责：

- `preflight` 是只读 Agent 门禁，用于判断仓库工作能否开始。
- 安装后的 pre-push Hook 使用候选提交锁定的引擎，在隔离的本地 clone 中验证每个拟推送 tip。
- `prepare-pr` 检查干净且已提交的变更，生成确定性 PR 报告和正文草稿，但不写入 GitHub 状态。

Preflight JSON 字段相互独立：`ok` 只表示检查完成，`status` 表示工作流结果，`repoState` 表示仓库接入状态。只有 `status: "succeeded"` 且 `repoState: "managed"` 才允许写入。可选 Agent 策略可以为 bootstrap 授权显式 Preset，但绝不授权 `github enforce --confirm`、创建 PR 或评论、修改 `ruleset`。

## RG001–RG009 能力地图

| 规则 | 治理对象 |
| --- | --- |
| `RG001` | 要求高影响变更提供已配置的配套测试改动，或成功执行声明的测试。 |
| `RG002` | 确保可执行测试只属于 `pr-blocking`、`nightly` 或 `manual-smoke` 中的一层。 |
| `RG003` | 确保受保护 workflow 调用声明的中央规则源，而不是复制实现。 |
| `RG004` | 锁定公共命令定义，并要求受影响的测试、文档和 workflow 消费者随已接受的变更一起更新。 |
| `RG005` | 将豁免审批绑定到允许的审批者、当前 PR head 与受治理的业务 diff。 |
| `RG006` | 校验 runtime、包管理器、依赖准备、有序执行阶段及其消费者。 |
| `RG007` | 执行仓库声明的架构依赖规则，并报告循环、漂移指标与健康分。 |
| `RG008` | 执行 Task Contract 的路径和范围预算，并报告确定性的任务漂移。 |
| `RG009` | 执行变更类别授权，以及文件、代码行和测试的比例预算。 |

这些规则只报告仓库已声明的事实。它们不能证明语义正确、断言质量、运行时调用方向，或用户目标已经实现。

## v1.5 新增能力

[v1.5](./docs/v1.5-release.md) 在保持配置 Schema v1、pre-push 协议 v1 和执行契约 v1 兼容的前提下，加入确定性的比例工程治理。

- **Task Contract v2** 新增 `small`、`standard`、`high` 和 `critical` 四级工程 Profile。
- **RG009** 从规范 Git diff 统计新增文件、增加行数、测试文件与测试增加行数。
- **显式变更授权**把仓库路径映射为类别，任务必须先声明允许的类别。
- **风险区**只能抬高、不能降低实际工程 Profile。
- **有限建议**返回最低验证范围，以及 `satisfied`、`needs-confirmation` 或 `blocked` 治理决策。
- **当前 diff 证据**允许 RG001 接受已声明测试的执行结果，但不会把本地 receipt 当作可移植证明。

完全保持内容不变的 rename 不消耗 RG009 的新增文件或增加行数预算。引擎绝不根据文件名或代码含义推断类别、Profile 或风险等级。

## 快速开始

### 从源码安装

开发和源码安装需要 Node.js 22 与 npm 10.9.2。也可以从 [GitHub 最新 Release](https://github.com/CoaseEdge/repo-governance/releases/latest) 获取经过验证的平台包。

```sh
git clone https://github.com/CoaseEdge/repo-governance.git
cd repo-governance
npm ci
npm run install:local
```

安装器会构建 engine 和自包含 launcher，把版本化数据写入平台用户数据目录，并创建托管的 `repo-governance` 命令入口。它绝不修改 shell profile；如果用户级 bin 目录不在 `PATH` 中，会返回一条明确的配置命令。

### 接入已有仓库

必须显式选择 Preset，repo-governance 不会自行猜测：

```sh
cd existing-repository
repo-governance bootstrap --preset node-library --json
```

内置 Preset 包括 `node-library`、`node-service`、`react-web`、`tauri-desktop` 和 `python-service`。Bootstrap 会写入治理配置与精简 GitHub Actions caller，连接现有 pre-push Hook；如果接入失败，会回滚本次创建的文件。

### 新建或克隆时接入治理

```sh
repo-governance new my-service --preset node-service --json
repo-governance clone https://example.com/team/project.git --preset node-service --json
```

`new` 只创建治理仓库，不生成业务代码；`clone` 保留原历史，并把生成的治理文件作为未提交变更留给开发者审阅。原生 `git init` 和 `git clone` 永远不会被拦截。

## 日常工作流

![检查结果示例，展示实际工程 Profile、验证建议、治理决策与停止建议](./docs/assets/readme/terminal-check.svg)

```sh
# Agent 修改仓库文件或运行任务测试前
repo-governance preflight --json

# 检查当前仓库变更
repo-governance check --json

# 为当前 diff 记录已声明测试的成功执行结果
repo-governance verify-test --entry <id> --json

# 计划纳入 PR 的改动已提交且工作区干净后
repo-governance prepare-pr --json
```

接入后，pre-push Hook 会自动运行。它会安全捕获 Hook 输入，把已有 Hook 保存为经过校验的 sidecar，并在 detached 本地 clone 中运行每个唯一的 tip/base 组合。它绝不 fetch，也不会降级到可变工作区配置、默认 engine 或旧版 `check` 路径。

## 命令面总览

| 工作流 | 命令 |
| --- | --- |
| 仓库生命周期 | `init`、`bootstrap`、`new`、`clone`、`update` |
| 变更治理 | `preflight`、`check`、`verify-test`、`prepare-pr` |
| 架构与失败基线 | `architecture baseline`、`architecture drift`、`baseline create`、`baseline compare` |
| Hook 管理 | `hooks install`、`connect`、`doctor`、`disconnect`、`uninstall` |
| 本机清单 | `repositories list/register/unregister`、`engines list/prune` |
| 验证分发 | `install`、`update`、`version check`、`skills install` |
| GitHub 强制层 | `github validate-waivers`、`github enforce` |

删除或远端写入必须使用 `engines prune --confirm`、`github enforce --confirm` 等显式命令；dry-run 或未确认形式保持只读。

## 架构与任务契约

| 契约 | 生命周期 | 用途 |
| --- | --- | --- |
| [架构契约](./docs/architecture-governance.md) | 仓库级、长期存在 | 为 RG007 声明层、模块与允许的依赖方向。 |
| [架构基线](./docs/architecture-drift.md) | 仓库级快照 | 跟踪结构漂移与确定性的 0–100 健康分。 |
| [Task Contract](./docs/change-scope-governance.md) | 单一目标、短期存在 | 为 RG008/RG009 声明允许路径、范围、变更类别、预算与工程 Profile。 |
| [执行契约](./docs/execution-contracts.md) | 版本化仓库策略 | 为 RG006 声明 runtime 与依赖、构建、代码生成、测试的有序执行图。 |

所有契约都必须显式声明。架构契约和 Task Contract 对已有仓库仍是可选能力；缺失的声明会继续保持缺失，引擎不会从项目惯例中合成策略。

## Codex 与 Claude Code

与 Agent 无关的建议知识位于 `playbooks/`。八个精简 Codex Skills 和八个对应的 Claude Code 命令模板调用锁定的 CLI，并解释其结构化报告；它们不会重新实现硬规则，也不能覆盖治理决策。

共享顾问覆盖测试影响、测试层级分类、CI 失败分诊、公共命令保护、架构审查、变更范围审查、Agent 预检门禁与接入。完整契约和安装模型见 [Agent 适配说明](./docs/agent-adapters.md)。

## 安全模型

- **离线执行：** preflight、仓库检查、Git Hooks、架构分析、范围评估和 pre-push 验证均不访问网络；`repo-governance version check` 是版本提醒中唯一联网的命令。
- **绑定 revision：** pre-push 读取候选提交的 engine identity 与协议；CI 使用事件声明的精确 head/base SHA。
- **失败关闭：** 协议字段缺失、版本不兼容、配置损坏、engine 缺失或校验失败都会阻断，而不是选择兜底路径。
- **最小权限：** 核心 PR 检查只拥有只读 contents 与 pull-request 权限；可选报告与不可信 checkout 执行相互隔离。
- **验证 Release：** 平台压缩包携带 checksum 与 GitHub artifact attestation；发布 catalog 具有独立的 Ed25519 detached signature。
- **显式远端写入：** GitHub enforcement 在没有 `--confirm` 时只读；写入后必须回读到真实生效的规则才算成功。

完整保证和限制见[接入模型](./docs/adoption-model.md)、[签名发布 catalog](./docs/release-catalog.md)与 [v1.5 发布边界](./docs/v1.5-release.md)。

## 文档导航

| 主题 | 指南 |
| --- | --- |
| Preset 与仓库接入 | [Preset 说明](./docs/presets.md) · [接入模型](./docs/adoption-model.md) · [Agent 自动接入](./docs/agent-auto-adoption.md) |
| 执行与 CI | [执行契约](./docs/execution-contracts.md) · [任务失败基线](./docs/task-failure-baseline.md) |
| 架构 | [架构治理](./docs/architecture-governance.md) · [架构漂移](./docs/architecture-drift.md) |
| 任务范围与比例工程 | [变更范围治理](./docs/change-scope-governance.md) · [v1.5 发布说明](./docs/v1.5-release.md) |
| Agent 集成 | [Agent 适配说明](./docs/agent-adapters.md) · [Codex adapter](./adapters/codex/README.md) · [Claude Code adapter](./adapters/claude-code/README.md) |
| Release 与升级 | [发布 catalog](./docs/release-catalog.md) · [历史版本](./docs/v1.4-release.md) |

## 开发

使用 Node.js 22：

```sh
npm ci
npm run check:static
npm test
```

使用 `npm run build:sea` 构建自包含 CLI 与版本感知 launcher。Hook 和接入测试必须使用隔离的临时 HOME 与仓库；开发期间绝不能接入或修改无关的已有仓库。

本项目采用 [MIT License](./LICENSE)。
