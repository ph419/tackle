# Tackle

> 基于插件的 AI Agent 工作流框架，为 Claude Code 提供任务管理、工作流编排、角色管理等能力

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-0.0.1-blue.svg)](https://github.com/your-org/tackle)

**[English](README.en.md)**

## 为什么选择 Tackle

你告诉 AI 需求，Tackle 帮你管好整个流程：

- **方案先行，人工把关** — AI 先输出实施方案和工作包拆分，等你确认后才动手写代码。不会出现「AI 自作主张改了一堆东西」的情况。
- **复杂需求，并行交付** — 大需求自动拆成多个独立模块，调度多个 Agent 同时工作。前后端、数据库变更同步推进，不用串行等待。
- **经验沉淀，越用越好** — 每次任务完成后自动提炼经验教训。下次遇到类似问题时，Agent 会参考历史经验做出更好的决策。



### 端到端数据流

用户需求经五个阶段完成从规划到交付的完整生命周期：

```mermaid
flowchart LR
    REQ["用户需求<br/>(自然语言)"]
    P0["P0: 规划<br/>task-creator / split-wp"]
    P1["P1: 审核<br/>human-checkpoint"]
    P2["P2: 执行<br/>agent-dispatcher"]
    P3["P3: 检查<br/>checklist / experience-logger"]
    P4["P4: 汇报<br/>completion-report"]

    O1["docs/wp/*.md<br/>task.md 更新"]
    O2["用户确认/修改<br/>(人工介入)"]
    O3["Agent Teams<br/>(多代理并行)"]
    O4["完成报告<br/>经验沉淀"]

    REQ --> P0 --> P1 --> P2 --> P3 --> P4

    P0 -.-> O1
    P1 -.-> O2
    P2 -.-> O3
    P3 -.-> O4
```

## 安装

```bash
npm install tackle
```

## 快速开始

```bash
# 进入你的项目目录
cd your-project

# 一键初始化（构建技能 + 注册钩子 + 创建配置目录）
npx tackle init

# 或者分步执行
npx tackle build      # 构建技能到 .claude/skills/，合并 hooks 到 settings.json
npx tackle validate   # 验证插件完整性
```

## 使用场景

### 场景一：新功能开发

**你的情况**：需要为 SaaS 产品添加「团队协作」模块，涉及前端界面、后端 API 和数据库变更。

**你只需要说**：
```
开始工作流，实现团队协作模块，包括：
- 团队创建和管理页面
- 成员邀请和权限 API
- 数据库表设计
```

**Tackle 会做什么**：
1. 分析需求复杂度，拆分为 4 个工作包（前端、后端、数据库、集成测试）
2. 输出每个工作包的实施方案，暂停等你审核
3. 你确认后，调度多个 Agent 并行开发各模块
4. 自动执行代码检查和测试验证
5. 生成完成报告，询问你下一步

**涉及技能**：workflow-orchestrator → split-work-package → human-checkpoint → agent-dispatcher → checklist → completion-report

### 场景二：Bug 批量修复

**你的情况**：Sprint 结束前积压了 5 个 Bug，希望能并行处理尽快收尾。

**你只需要说**：
```
批量执行 WP-015 到 WP-019，并行修复这 5 个 Bug
```

**Tackle 会做什么**：
1. 分析 5 个 Bug 之间的依赖关系（有没有改动同一文件）
2. 无冲突的 Bug 分配给不同 Agent 同时修复
3. 有依赖的 Bug 按顺序排队，前一个完成后自动启动下一个
4. 全部修复后运行检查清单，确认没有引入新问题

**涉及技能**：agent-dispatcher → checklist → completion-report

### 场景三：系统重构

**你的情况**：需要将单体应用拆分为微服务架构，涉及多个模块的协调改动，担心改出问题。

**你只需要说**：
```
拆分工作包，将用户模块从单体应用中拆分为独立服务
```

**Tackle 会做什么**：
1. 深入分析代码结构，识别所有需要改动的模块和依赖关系
2. 生成详细的重构计划（接口抽取、数据迁移、路由调整等）
3. 暂停等你审核架构方案（这是关键决策点）
4. 按依赖顺序分批执行重构，每批完成后自动验证
5. 记录重构经验，下次类似的拆分任务可以直接参考

**涉及技能**：split-work-package → human-checkpoint → agent-dispatcher → checklist → experience-logger → completion-report

## 命令一览

| 命令 | 说明 |
|------|------|
| `npx tackle` | 默认执行 build |
| `npx tackle build` | 构建所有技能，更新 .claude/settings.json |
| `npx tackle validate` | 验证插件格式是否正确 |
| `npx tackle init` | 首次安装：build + 创建 .claude/ 目录 |
| `npx tackle --root <path>` | 指定目标项目路径（默认为当前目录） |
| `npx tackle --help` | 查看帮助信息 |

## 技能清单

| 技能 | 触发方式 | 功能 |
|------|----------|------|
| task-creator | "创建任务" / "create task" | 创建单个任务到任务列表 |
| batch-task-creator | "批量创建任务" / "batch create tasks" | 批量创建多个任务 |
| split-work-package | "拆分工作包" / "split work package" | 将需求拆分为可执行的工作包 |
| progress-tracker | "记录进度" / "record progress" | 追踪和汇报工作进度 |
| team-cleanup | "清理团队" / "cleanup team" | 释放残留的团队资源 |
| human-checkpoint | "等待审核" / "wait for review" | 暂停并请求人工确认 |
| role-manager | "查看角色" / "view roles" | 管理项目角色定义 |
| checklist | "运行检查" / "run checklist" | 执行检查清单 |
| completion-report | "完成报告" / "completion report" | 生成完成报告 |
| experience-logger | "总结经验" / "log experience" | 记录项目经验教训 |
| agent-dispatcher | "批量执行" / "dispatch agents" | 调度多个子代理并行工作 |
| workflow-orchestrator | "开始工作流" / "start workflow" | 编排完整工作流 |

## 工作流概览

用户需求经过 5 个阶段完成从规划到交付：

```
需求 → 规划(P0) → 审核(P1) → 执行(P2) → 检查(P3) → 汇报(P4) → 交付
```

| 阶段 | 做什么 | 关键技能 |
|------|--------|----------|
| **P0 规划** | 解析需求，拆分为工作包，写入文档 | task-creator, split-work-package |
| **P1 审核** | 暂停等待你确认方案（强制人工介入） | human-checkpoint |
| **P2 执行** | 多 Agent 并行开发，按依赖调度 | agent-dispatcher |
| **P3 检查** | 代码/测试/文档质量验证，提炼经验 | checklist, experience-logger |
| **P4 汇报** | 生成完成报告，询问下一步 | completion-report |

> 完整的数据流图和阶段细节请参阅 [docs/ai_workflow.md](docs/ai_workflow.md)

## 插件架构

Tackle 包含四类插件，共 18 个：

| 类型 | 数量 | 作用 |
|------|------|------|
| Skill | 12 | 可执行技能，Claude Code 直接调用 |
| Provider | 3 | 状态存储、角色注册、记忆存储 |
| Hook | 1 | 技能门控，拦截编辑操作和技能调用 |
| Validator | 2 | 文档同步验证、工作包验证 |

> 插件依赖关系和开发指南请参阅 [docs/plugin-development.md](docs/plugin-development.md)

## 构建后的项目结构

执行 `tackle build` 后，你的项目中会生成以下内容：

```
your-project/
  .claude/
    skills/                          # 12 个技能
      skill-task-creator/skill.md
      skill-batch-task-creator/skill.md
      skill-split-work-package/skill.md
      skill-progress-tracker/skill.md
      skill-team-cleanup/skill.md
      skill-human-checkpoint/skill.md
      skill-role-manager/skill.md
      skill-checklist/skill.md
      skill-completion-report/skill.md
      skill-experience-logger/skill.md
      skill-agent-dispatcher/skill.md
      skill-workflow-orchestrator/skill.md
    settings.json                    # 自动注册的 hooks
```

## 常见问题

### 安装后技能没有生效？

确保在项目根目录执行了 `npx tackle build`，并且 `.claude/skills/` 目录下有 12 个技能文件夹。

### 多个项目能否共用？

每个项目独立安装、独立构建。不同项目可以安装不同版本。

### 全局安装

```bash
npm install -g tackle
tackle build
```

全局安装后直接使用 `tackle` 命令，无需 `npx`。

### 如何卸载？

```bash
npm uninstall tackle
```

技能文件会保留在 `.claude/skills/` 中，如需清理请手动删除。

### settings.json 中的 hooks 是什么？

`tackle build` 会自动向 `.claude/settings.json` 注入两个 hook：
- `PreToolUse(Edit|Write)` — 在特定状态下阻止文件编辑
- `PostToolUse(Skill)` — 技能调用后更新状态

这些 hook 指向 `node_modules/tackle/` 中的脚本，不会影响你项目中的其他配置。已有的 settings.json 内容会被保留，仅追加 tackle 相关的 hooks。

## 文档

- [配置参考](docs/config-reference.md) - 完整的配置文件说明
- [最佳实践](docs/best-practices.md) - 使用建议和优化技巧
- [插件开发](docs/plugin-development.md) - 插件架构和开发指南
- [工作流详解](docs/ai_workflow.md) - 完整的工作流数据流和阶段说明

## 贡献

欢迎贡献！我们接受 Bug 报告、功能建议、代码提交和文档改进。详见 [贡献指南](CONTRIBUTING.md)。

快速上手：Fork → 创建分支 → 修改 → 提交 PR。Commit 遵循 [Conventional Commits](https://www.conventionalcommits.org/) 格式。

## 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

## 致谢

本项目借鉴了以下开源项目的优秀设计：
- DeerFlow - 记忆提取和中间件架构
- Model Context Protocol - 工具集成标准
