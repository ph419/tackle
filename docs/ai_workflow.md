# AI Agent Harness — AI 工作流技术文档

> 版本: 3.0.0 | 更新日期: 2026-04-03

---

## 目录

1. [概述](#1-概述)
2. [架构总览](#2-架构总览)
3. [插件体系与依赖关系](#3-插件体系与依赖关系)
4. [核心工作流详解](#4-核心工作流详解)
   - 4.1 [标准开发工作流（主流程）](#41-标准开发工作流主流程)
   - 4.2 [任务创建流水线](#42-任务创建流水线)
   - 4.3 [多代理调度与执行](#43-多代理调度与执行)
   - 4.4 [经验提炼与角色进化](#44-经验提炼与角色进化)
   - 4.5 [质量检查与完成报告](#45-质量检查与完成报告)
5. [辅助工作流](#5-辅助工作流)
   - 5.1 [快速修复工作流](#51-快速修复工作流)
   - 5.2 [代码审查工作流](#52-代码审查工作流)
   - 5.3 [文档更新工作流](#53-文档更新工作流)
6. [运行时基础设施](#6-运行时基础设施)
7. [关键代码引用](#7-关键代码引用)
8. [配置文件索引](#8-配置文件索引)

---

## 1. 概述

AI Agent Harness 是一个**配置驱动的 AI Agent 工作流框架**，采用插件化架构管理 AI 代理从任务创建到完成交付的完整生命周期。框架的核心设计理念：

- **文档优先（Document-First）**：任务定义与代码实现严格分离，创建阶段只写文档不写代码
- **人机协作（Human-in-the-Loop）**：关键决策点强制暂停等待人类确认
- **角色进化（Role Evolution）**：代理通过经验积累逐步提升领域专业能力
- **并行调度（Parallel Dispatch）**：基于依赖图的多代理并行任务执行

### 术语对照

| 术语 | 含义 |
|------|------|
| Skill | AI 可调用的能力单元（Claude Code Skill） |
| Provider | 底层能力提供者（状态存储、角色注册等） |
| Hook | 生命周期钩子（拦截工具调用事件） |
| Validator | 输出验证器（检查文档/结构一致性） |
| Teamee | 团队中的子代理，由 Lead Agent 调度 |
| WP（Work Package） | 工作包，最小可执行任务单元 |

---

## 2. 架构总览

### 2.1 四层插件架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     Skill 层（13 个可执行技能）                    │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│  │task-creator  │ │agent-dispatch│ │workflow-orchestrator     │ │
│  └──────────────┘ └──────────────┘ └──────────────────────────┘ │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────────┐ │
│  │checklist     │ │exp-logger    │ │completion-report         │ │
│  └──────────────┘ └──────────────┘ └──────────────────────────┘ │
│  ... 等 7 个辅助 Skill                                           │
├─────────────────────────────────────────────────────────────────┤
│                     Hook 层（2 个生命周期钩子）                    │
│  ┌──────────────────────────────────────────────────────────────┐│
│  │ hook-skill-gate     ── 拦截 Edit/Write 操作，状态门控       ││
│  │ hook-session-start  ── 会话启动时注入 plan-mode 规则        ││
│  └──────────────────────────────────────────────────────────────┘│
├─────────────────────────────────────────────────────────────────┤
│                     Validator 层（2 个验证器）                     │
│  ┌──────────────────┐  ┌─────────────────────────────────────┐  │
│  │validator-doc-sync│  │validator-work-package               │  │
│  └──────────────────┘  └─────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                     Provider 层（4 个能力提供者）                   │
│  ┌──────────────┐  ┌──────────────┐                              │
│  │  state-store │  │ role-registry │                              │
│  └──────────────┘  └──────────────┘                              │
│  ┌──────────────┐  ┌──────────────┐                              │
│  │ memory-store │  │  watchdog    │                              │
│  └──────────────┘  └──────────────┘                              │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 端到端数据流全景图

```
┌──────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  用户需求  │───▶│  P0: 规划    │───▶│  P1: 审核    │───▶│  P2: 执行    │───▶│ P3: 检查交付 │
│  (自然语言) │    │  task-creator│    │  human-      │    │  agent-      │    │  checklist   │
│            │    │  split-wp    │    │  checkpoint  │    │  dispatcher  │    │  exp-logger  │
└──────────┘    └──────┬───────┘    └──────┬───────┘    └──────┬───────┘    └──────┬───────┘
                       │                   │                   │                   │
                       ▼                   ▼                   ▼                   ▼
               ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
               │ docs/wp/*.md │    │ 用户确认/修改 │    │ Agent Teams  │    │ 完成报告     │
               │ task.md 更新  │    │ (人工介入)    │    │ (多代理并行)  │    │ 经验沉淀     │
               └──────────────┘    └──────────────┘    └──────────────┘    └──────────────┘
                                                                          │
                                                                          ▼
                                                                  ┌──────────────┐
                                                                  │ P4: 汇报询问 │
                                                                  │ completion   │
                                                                  │ -report      │
                                                                  └──────────────┘
```

---

## 3. 插件体系与依赖关系

### 3.1 插件依赖图

```
provider-state-store ──────────┬──→ skill-task-creator
(文件级 KV 存储)               ├──→ skill-batch-task-creator
                               ├──→ skill-split-work-package
                               ├──→ skill-workflow-orchestrator
                               └──→ skill-completion-report

provider-role-registry ────┬──→ skill-agent-dispatcher
(角色定义注册表)            └──→ skill-role-manager

provider-memory-store ─────┬──→ skill-experience-logger
(记忆存储管理)              └──→ skill-agent-dispatcher

hook-skill-gate ──────────────→ provider-state-store
(门控 Hook, 拦截 Edit/Write)

skill-progress-tracker    (无外部依赖)
skill-team-cleanup        (无外部依赖)
skill-human-checkpoint    (无外部依赖)
skill-checklist           (无外部依赖)

validator-doc-sync        (无外部依赖)
validator-work-package    (无外部依赖)
```

### 3.2 插件注册表

所有插件在 `plugins/plugin-registry.json` 中统一注册，每个条目包含 `name`、`source`（指向 `plugins/core/` 下的目录）、`enabled` 状态和可选 `config`。

**关键文件**: `plugins/plugin-registry.json:1-119`

---

## 4. 核心工作流详解

### 4.1 标准开发工作流（主流程）

**编排者**: `skill-workflow-orchestrator`
**配置来源**: `.claude/config/workflows-config.yaml` → `standard-dev`

#### 流程图

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │                                                                     │
  │  用户触发: "开始工作流" / "执行完整流程"                              │
  │                                                                     │
  └───────────────────────────┬─────────────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  P0: 需求与规划                                                     │
  │                                                                     │
  │  ┌────────────────┐    ┌─────────────────┐    ┌────────────────┐   │
  │  │ 1. 解析需求     │───▶│ 2. 评估复杂度    │───▶│ 3. 拆分工作包  │   │
  │  │    (AI 理解)    │    │   (5维矩阵打分) │    │  (simple/std/  │   │
  │  │                │    │                 │    │   fine-grained)│   │
  │  └────────────────┘    └─────────────────┘    └────────────────┘   │
  │         │                                           │               │
  │         ▼                                           ▼               │
  │  ┌────────────────┐                        ┌────────────────┐       │
  │  │ 读取 task.md   │                        │ 写入 WP 文档   │       │
  │  │ (获取最新编号)  │                        │ docs/wp/*.md   │       │
  │  └────────────────┘                        └────────────────┘       │
  │                                                     │               │
  └─────────────────────────────────────────────────────┼───────────────┘
                                                        │
                              ┌─────────────────────────┘
                              ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  P1: 人介入审核  🔴 强制暂停                                        │
  │                                                                     │
  │  ┌──────────────────────────────────────────────────────────────┐   │
  │  │  输出审核清单 → 等待用户确认                                   │   │
  │  │                                                              │   │
  │  │  用户回复 "继续" ──→ 进入 P2                                  │   │
  │  │  用户回复 "修改" ──→ 回到 P0 重新规划                          │   │
  │  └──────────────────────────────────────────────────────────────┘   │
  └───────────────────────────┬─────────────────────────────────────────┘
                              │ 确认
                              ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  P2: 执行实现                                                       │
  │                                                                     │
  │  ┌──────────────────────────────────────────────────────────────┐   │
  │  │              Agent Teams 多代理调度模式                       │   │
  │  │                                                              │   │
  │  │   Lead Agent                                                 │   │
  │  │   ├── TeamCreate 创建团队                                    │   │
  │  │   ├── TaskCreate × N (创建任务 + 设置依赖)                    │   │
  │  │   ├── 角色匹配 → 确定专家类型                                 │   │
  │  │   ├── Agent × M (启动 Teamee + 注入角色+记忆)                │   │
  │  │   └── 监控 TaskList → 全部完成 → TeamDelete                  │   │
  │  │                                                              │   │
  │  │   Teamee (自主执行)                                          │   │
  │  │   ├── TaskList 查看可用任务                                   │   │
  │  │   ├── TaskUpdate 认领 → 执行 → 标记完成                      │   │
  │  │   └── 等待 shutdown_request                                  │   │
  │  └──────────────────────────────────────────────────────────────┘   │
  └───────────────────────────┬─────────────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  P3: 检查与交付                                                     │
  │                                                                     │
  │  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │
  │  │ checklist    │───▶│ exp-logger   │───▶│ 更新 task.md 状态    │  │
  │  │ (5类质量检查) │    │ (经验提炼)   │    │ 📋→✅               │  │
  │  └──────────────┘    └──────────────┘    └──────────────────────┘  │
  └───────────────────────────┬─────────────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────────────────┐
  │  P4: 汇报询问                                                       │
  │                                                                     │
  │  ┌──────────────────────────────────────────────────────────────┐   │
  │  │  completion-report → 生成标准化报告                           │   │
  │  │  🔴 "下一步安排是什么？" → 等待用户指令                       │   │
  │  │                                                              │   │
  │  │  用户: "继续 WP-XXX" ──→ 回到 P2                             │   │
  │  │  用户: "创建新任务" ──→ 回到 P0                               │   │
  │  │  用户: "结束" ──→ 退出                                       │   │
  │  └──────────────────────────────────────────────────────────────┘   │
  └─────────────────────────────────────────────────────────────────────┘
```

#### 输入 / 输出

| 阶段 | 输入 | 输出 | 涉及 Skill |
|------|------|------|------------|
| P0 规划 | 用户自然语言需求 | `docs/wp/WP-XXX.md`、`task.md` 更新 | task-creator, split-work-package |
| P1 审核 | 规划文档 + 审核清单 | 用户确认或修改意见 | human-checkpoint |
| P2 执行 | 工作包文档 + 角色定义 | 代码文件 + 测试文件 | agent-dispatcher |
| P3 检查 | 实现产物 + 测试结果 | 检查报告 + 经验记录 | checklist, experience-logger |
| P4 汇报 | 全流程执行结果 | 标准化完成报告 | completion-report |

#### 阶段间错误恢复

| 失败场景 | 恢复策略 |
|----------|----------|
| P0 需求不明确 | 回到用户澄清 |
| P1 用户要求修改 | 重新规划后再次审核 |
| P2 工作包执行失败 | 记录失败原因，继续其他工作包 |
| P3 Checklist 不通过 | 修复问题后重新检查 |
| P4 用户不满意 | 回到 P2 修正 |

**关键文件**: `plugins/core/skill-workflow-orchestrator/skill.md:1-275`

---

### 4.2 任务创建流水线

**核心 Skill**: `skill-task-creator`
**设计原则**: 文档优先 — 创建 ≠ 执行

#### 复杂度评估与拆分决策

```
                  ┌────────────────────────────────────┐
                  │  复杂度评估矩阵 (5 维度, 每维 1-3 分) │
                  │                                    │
                  │  文件影响范围  ≤2=1  3-5=2  >5=3    │
                  │  模块数量      1=1  2-3=2  >3=3     │
                  │  接口变更程度  无=1  修改=2  新增=3   │
                  │  测试用例预估  ≤5=1 6-15=2  >15=3   │
                  │  预估AI时间   ≤5m=1 5-30m=2  >30m=3 │
                  └──────────────┬─────────────────────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │     总分计算与决策       │
                    │                        │
                    │  ≤ 6  ──▶ simple       │
                    │           (不拆分)       │
                    │                        │
                    │  7-12 ──▶ standard     │
                    │           (4 阶段拆分)   │
                    │                        │
                    │  > 12 ──▶ fine-grained │
                    │           (多模块并行)   │
                    └────────────────────────┘
```

#### 三种拆分模式的依赖链

```
模式 A: simple (≤6分)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
  WP-XXX: 实现任务
  └── 角色: 领域专家


模式 B: standard (7-12分)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
  WP-XXX-1-impl ──▶ WP-XXX-2-test ──▶ WP-XXX-3-verify ──▶ WP-XXX-4-review
  (领域专家)         (tester)          (tester)            (reviewer)


模式 C: fine-grained (>12分)
━━━━━━━━━━━━━━━━━━━━━━━━━━━
  WP-XXX-1-impl-a ──▶ WP-XXX-2-test-a ──┐
  WP-XXX-1-impl-b ──▶ WP-XXX-2-test-b ──┼──▶ WP-XXX-3-verify ──▶ WP-XXX-4-review
                                          │
  (多个模块可并行)                          └── 汇聚后统一验证
```

#### 执行步骤

| Step | 行为 | 允许操作 | 禁止操作 |
|------|------|----------|----------|
| 0 | 进入 Plan 模式 | 读取项目文件 | 写入代码 |
| 1-6 | Plan Mode: 分析+规划 | 评估复杂度、设计拆分方案 | 修改任何代码文件 |
| 6.5 | 请求用户确认 Plan | AskUserQuestion | ExitPlanMode |
| 7 | 写入 `docs/wp/WP-XXX.md` | 写入文档文件 | 写入代码 |
| 8 | 更新 `task.md` | 追加概览表行 | — |
| 9 | 输出简洁报告 | — | 自动继续执行 |

**关键文件**: `plugins/core/skill-task-creator/skill.md:1-686`

---

### 4.3 多代理调度与执行

**核心 Skill**: `skill-agent-dispatcher`
**底层机制**: Claude Code Agent Teams (TeamCreate / TaskCreate / TaskList)

#### 调度架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Lead Agent (主代理)                        │
│                                                                     │
│   1. 解析工作包清单                                                  │
│   2. 分析依赖关系 (拓扑排序 + 循环检测)                               │
│   3. TeamCreate → 创建命名团队                                       │
│   4. TaskCreate × N → 创建任务 + blockedBy 依赖                     │
│   5. 角色匹配 → 从 role-registry.yaml 确定专家类型                    │
│   6. 记忆注入 → 从 memories/{role}.md 注入历史经验                   │
│   7. Agent × M → 启动 Teamee (general-purpose 类型)                  │
│   8. 监控循环 → TaskList 轮询直到全部完成                             │
│   9. TeamDelete → 清理团队资源 (强制, 多次验证)                       │
│  10. 经验提取 → 写入角色专属库 + EXPERIENCE.md                        │
└────────────┬──────────────────┬──────────────────┬──────────────────┘
             │                  │                  │
     ┌───────▼──────┐  ┌───────▼──────┐  ┌───────▼──────┐
     │  Teamee #1   │  │  Teamee #2   │  │  Teamee #3   │
     │  角色: 专家A  │  │  角色: 专家B  │  │  角色: 专家C  │
     │              │  │              │  │              │
     │ · TaskList   │  │ · TaskList   │  │ · TaskList   │
     │ · 自主认领   │  │ · 自主认领   │  │ · 自主认领   │
     │ · 执行完成   │  │ · 执行完成   │  │ · 等待解锁   │
     │ · TaskUpdate │  │ · TaskUpdate │  │ · TaskUpdate │
     └───────┬──────┘  └───────┬──────┘  └───────┬──────┘
             │                  │                  │
             └──────────────────┼──────────────────┘
                                ▼
                  ┌──────────────────────────────┐
                  │     共享 Task List            │
                  │                               │
                  │  Task #1: ✅ completed        │
                  │  Task #2: 🔄 in_progress     │
                  │  Task #3: ⏳ blockedBy [#2]   │
                  └──────────────────────────────┘
```

#### 角色匹配算法

```
分数 = 关键词匹配数 × 0.5  +  任务类型匹配 × 0.3  +  模块标签匹配 × 0.2

匹配来源:
  - keywords: 角色定义 YAML 中的 keywords 字段
  - task_types: 角色定义 YAML 中的 task_types 字段
  - module_tags: 角色定义 YAML 中的 module_tags 字段

回退策略: 无匹配时使用 default_role = implementer
```

#### 记忆注入机制

```
1. 读取角色专属库: .claude/agents/memories/{role_id}.md
2. 回退: 如专属库不足, 读取 docs/EXPERIENCE.md
3. 按标签过滤: 使用角色的 experience_tags 过滤
4. 动态数量:
     简单任务 (<2h):  1-2 条经验
     中等任务 (2-4h): 3 条经验
     复杂任务 (>4h):  5 条经验
```

#### 强制清理流程 (Step 7)

```
  ┌────────────────────────────────────────────────────────────┐
  │               Cleanup Guarantee (清理保障)                  │
  │                                                            │
  │  Step 7a: 安全检查 (3 个前置条件)                            │
  │    ├── team_name 合法性校验                                  │
  │    ├── 团队目录存在性检查                                    │
  │    └── 路径安全验证                                         │
  │                                                            │
  │  Step 7b: 发送 shutdown_request 给所有 Teamee                │
  │  Step 7c: 等待响应 (最多 15s)                                │
  │  Step 7d: TeamDelete 第 1 次 + Bash 验证目录删除             │
  │  Step 7e: TeamDelete 第 2 次 (重试) + Bash 验证             │
  │  Step 7f: 文件系统级强制清理 (rm -rf 回退方案)               │
  │  Step 7g: 最终验证                                          │
  │  Step 7h: 记录清理日志                                      │
  │                                                            │
  │  ❌ 无任何情况可以跳过 TeamDelete！                          │
  └────────────────────────────────────────────────────────────┘
```

**关键文件**: `plugins/core/skill-agent-dispatcher/skill.md:1-912`

---

### 4.4 经验提炼与角色进化

**核心 Skill**: `skill-experience-logger`
**数据流**: 任务执行结果 → 经验识别 → 标签分类 → 角色匹配 → 双重写入

#### 经验提炼流程

```
  ┌──────────────────────────────────────────────────────────────────┐
  │                     经验提炼流水线                                │
  │                                                                  │
  │  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐   │
  │  │ 1.回顾    │───▶│ 2.识别    │───▶│ 3.标签    │───▶│ 4.角色    │   │
  │  │ 对话上下文 │    │ 问题+方案 │    │ 分类选择  │    │ 匹配关联  │   │
  │  └──────────┘    └──────────┘    └──────────┘    └──────────┘   │
  │                                                       │         │
  │                                                       ▼         │
  │  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐   │
  │  │ 7.更新    │◀───│ 6.同步到  │◀───│ 5.写入    │◀───│ 角色专属  │   │
  │  │ 角色统计  │    │ EXPERIENCE│    │ 角色专属库 │    │ 库路径   │   │
  │  │          │    │ .md       │    │          │    │          │   │
  │  └──────────┘    └──────────┘    └──────────┘    └──────────┘   │
  └──────────────────────────────────────────────────────────────────┘
```

#### 标签到角色映射

| 经验标签 | 关联角色 |
|----------|----------|
| `[架构设计]` `[系统设计]` `[模块划分]` | architect |
| `[代码实现]` `[功能开发]` `[Bug修复]` `[重构]` `[调试]` | implementer |
| `[测试验证]` `[单元测试]` `[集成测试]` `[测试框架]` | tester |
| `[文档编写]` `[API文档]` `[用户指南]` | documenter |
| `[性能优化]` | architect + implementer |
| `[项目管理]` `[任务调度]` | coordinator |

#### 双重写入策略

```
写入路径 1 (精准匹配):
  .claude/agents/memories/{role_id}.md
  → 作为子代理记忆注入源
  → 实现角色进化

写入路径 2 (全局共享):
  docs/EXPERIENCE.md
  → 全局知识库
  → 作为回退经验源
```

#### 角色进化收益曲线

```
  能力
   ▲
   │              ┌──────────────
   │             /  领域专家
   │            /   (16+ 次)
   │           /
   │      ┌───/
   │      │  积累专属经验
   │      │  (6-15 次)
   │  ┌───/
   │  │ 基础能力
   │  │ (1-5 次)
   ──┼────────────────────────▶ 使用次数
```

**关键文件**: `plugins/core/skill-experience-logger/skill.md:1-236`

---

### 4.5 质量检查与完成报告

**核心 Skill**: `skill-checklist` + `skill-completion-report`

#### 检查清单流程

```
  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
  │ 读取      │───▶│ 匹配      │───▶│ 执行      │───▶│ 生成      │
  │ CHECKLIST │    │ EXPERIENCE│    │ 检查项    │    │ 报告      │
  │ .md       │    │ .md       │    │          │    │          │
  └──────────┘    └──────────┘    └──────────┘    └──────────┘
                                      │
                          ┌───────────┤
                          ▼           ▼
                    ┌──────────┐  ┌──────────┐
                    │ 5类检查   │  │ 有问题?   │
                    │          │  │          │
                    │ 1.代码质量│  │ ──→ 查阅  │
                    │ 2.测试检查│  │     经验库 │
                    │ 3.文档检查│  │     修复   │
                    │ 4.Git检查 │  │     ↺重检  │
                    │ 5.经验记录│  │          │
                    └──────────┘  └──────────┘
```

#### 完成报告流程

```
  任务完成
     │
     ▼
  收集执行结果 ──▶ 生成标准化报告
                       │
                       ▼
              ┌────────────────────┐
              │ 强制文档同步 (不可跳过) │
              │                      │
              │  task.md: 📋 → ✅    │
              │  WP文档: 更新状态     │
              │  Bash 验证同步结果    │
              └────────┬─────────────┘
                       │
                       ▼
              运行门控验证
                       │
                 ┌─────┤
                 ▼     ▼
               通过   失败 → 修复 → ↺
                 │
                 ▼
              执行 checklist
                 │
                 ▼
              记录经验 (experience-logger)
                 │
                 ▼
              🔴 "下一步安排是什么？"
                 │
           ┌─────┼─────┐
           ▼     ▼     ▼
        继续执行  新任务  结束
```

**关键文件**: `plugins/core/skill-checklist/skill.md:1-116`, `plugins/core/skill-completion-report/skill.md:1-332`

---

## 5. 辅助工作流

### 5.1 快速修复工作流

**触发**: 用户报告 Bug 或需要快速修复
**配置来源**: `workflows-config.yaml` → `quick-fix`

```
  诊断 ──▶ 修复 ──▶ 验证 🔴
```

| 阶段 | Skill | 检查点 |
|------|-------|--------|
| diagnosis | debugger | 无 |
| fix | coder | 无 |
| verify | tester | **强制** |

### 5.2 代码审查工作流

**触发**: Pull Request 审查
**配置来源**: `workflows-config.yaml` → `code-review`

```
  预审查(自动) ──▶ 深度审查 🔴 ──▶ 处理审查意见
```

### 5.3 文档更新工作流

**触发**: 需要更新项目文档
**配置来源**: `workflows-config.yaml` → `documentation`

```
  分析 ──▶ 更新 ──▶ 验证 🔴
```

---

## 6. 运行时基础设施

### 6.1 状态存储 (StateStore)

基于文件的 KV 存储，支持嵌套 key（dot-notation）和订阅通知机制。

```
  ┌────────────────────────────────────────────────────┐
  │                  StateStore                        │
  │                                                    │
  │  FileSystemAdapter                                 │
  │  ├── 文件路径: .claude-state                       │
  │  ├── 格式: JSON                                    │
  │  └── 自动创建目录                                   │
  │                                                    │
  │  内存缓存 (_cache)                                  │
  │  └── 首次读取后缓存, invalidate() 强制重读           │
  │                                                    │
  │  订阅机制 (_subscribers: Map<key, callback[]>)      │
  │  └── set() 时自动通知订阅者                         │
  │                                                    │
  │  API:                                              │
  │  ├── get(key)        → Promise<value>              │
  │  ├── set(key, value) → Promise<void>               │
  │  ├── delete(key)     → Promise<void>               │
  │  ├── subscribe(key, cb) → { unsubscribe() }        │
  │  ├── keys()          → Promise<string[]>           │
  │  └── invalidate()    → void                        │
  └────────────────────────────────────────────────────┘
```

**关键文件**: `plugins/runtime/state-store.js:1-278`

### 6.2 技能门控 (Skill Gate Hook)

生命周期钩子，拦截 Edit/Write 操作并管理状态门控。

```
  ┌─────────────────────────────────────────────────────────────┐
  │                    Skill Gate Hook                           │
  │                                                             │
  │  PreToolUse(Edit|Write)                                     │
  │  ├── 读取当前状态 (StateStore)                               │
  │  ├── 检查是否处于 blockedStates (如 "waiting")               │
  │  ├── blocked → 返回 { allowed: false }                      │
  │  └── allowed → 返回 { allowed: true }                       │
  │                                                             │
  │  PostToolUse(Skill)                                         │
  │  ├── 动态发现 gated skills (读 plugin-registry.json)         │
  │  ├── 检查刚执行的 skill 是否在 gated 列表中                   │
  │  └── 是 → 设置状态为 "waiting" (暂停等待人工确认)             │
  │                                                             │
  │  CLI 入口:                                                   │
  │  node index.js --pre-tool   (PreToolUse 检查)               │
  │  node index.js --post-skill (PostToolUse 处理)              │
  └─────────────────────────────────────────────────────────────┘
```

**关键文件**: `plugins/core/hook-skill-gate/index.js:1-438`

### 6.3 构建工具 (HarnessBuild)

将 `plugins/core/` 下的插件转换为 Claude Code 原生格式。

```
  ┌──────────────────────────────────────────────────────────────┐
  │  输入: plugins/plugin-registry.json + plugins/core/*         │
  │                                                              │
  │  转换规则:                                                    │
  │  ├── skill    → .claude/skills/{name}/skill.md              │
  │  ├── hook     → .claude/hooks/{name}/index.js               │
  │  ├── validator → (内部注册, 无原生输出)                       │
  │  └── provider  → (内部注册, 无原生输出)                       │
  │                                                              │
  │  命令:                                                       │
  │  tackle-harness build       # 构建                              │
  │  tackle-harness validate    # 仅验证                            │
  │                                                              │
  │  输出: Build Report (插件数/类型/文件数/错误)                 │
  └──────────────────────────────────────────────────────────────┘
```

**关键文件**: `plugins/runtime/harness-build.js:1-834`

### 6.4 插件契约 (Plugin Interface)

所有插件的基类定义，提供统一的生命周期管理。

```
  Plugin (基类)
  ├── type, name, version, description
  ├── state: discovered → loaded → resolved → activated → running → deactivated → unloaded
  ├── onActivate(context) / onDeactivate()
  │
  ├── SkillPlugin
  │   ├── triggers: string[]
  │   ├── metadata: { stage, requiresPlanMode, gatedByHuman, gatedByCode }
  │   └── execute(context, args)
  │
  ├── HookPlugin
  │   ├── trigger: { event: 'PreToolUse'|'PostToolUse', tools, skills }
  │   ├── priority: number
  │   └── handle(context)
  │
  ├── ValidatorPlugin
  │   ├── targets: string[]
  │   ├── blocking: boolean
  │   └── validate(context)
  │
  └── ProviderPlugin
      ├── provides: string
      └── factory(context)
```

**关键文件**: `plugins/contracts/plugin-interface.js:1-245`

---

## 7. 关键代码引用

### 7.1 插件注册表加载

| 功能 | 文件路径 | 说明 |
|------|----------|------|
| 注册表定义 | `plugins/plugin-registry.json:1-147` | 21 个插件的声明与配置 |
| 构建入口 | `plugins/runtime/harness-build.js:106-144` | `build()` 方法，遍历注册表构建所有插件 |
| 插件发现 | `plugins/runtime/harness-build.js:150-185` | `_getPluginEntries()`，过滤 disabled 插件 |

### 7.2 状态管理与门控

| 功能 | 文件路径 | 说明 |
|------|----------|------|
| KV 存储 | `plugins/runtime/state-store.js:73-170` | get/set/delete/subscribe API |
| 嵌套 key 支持 | `plugins/runtime/state-store.js:206-235` | `_getNested()`/`_setNested()` dot-notation |
| 门控 Hook | `plugins/core/hook-skill-gate/index.js:186-301` | PreToolUse 拦截 + PostToolUse 状态设置 |
| 门控 Skill 发现 | `plugins/core/hook-skill-gate/index.js:66-117` | `discoverGatedSkills()` 动态扫描 plugin.json |

### 7.3 工作流配置

| 功能 | 文件路径 | 说明 |
|------|----------|------|
| 标准工作流 | `.claude/config/workflows-config.yaml:11-73` | 4 阶段 + entry/exit hooks |
| 快速修复 | `.claude/config/workflows-config.yaml:76-103` | 3 阶段简化流程 |
| 阶段转换规则 | `.claude/config/workflows-config.yaml:166-189` | 自动转换 + 检查点转换 |
| 主配置 | `.claude/config/harness-config.yaml:16-49` | 默认工作流 4 阶段定义 |

### 7.4 角色系统

| 功能 | 文件路径 | 说明 |
|------|----------|------|
| 角色注册表 | `.claude/agents/role-registry.yaml:1-144` | 分类 + 别名 + 标签映射 + 权重 |
| 匹配权重 | `.claude/agents/role-registry.yaml:125-130` | keyword=0.5, task_type=0.3, module_tag=0.2 |
| 元角色定义 | `.claude/agents/roles/meta/*.yaml` | coordinator, executor, specialist, reviewer |
| 职能角色定义 | `.claude/agents/roles/functional/*.yaml` | architect, implementer, tester, documenter |

---

## 8. 配置文件索引

| 配置文件 | 路径 | 用途 |
|----------|------|------|
| 主配置 | `.claude/config/harness-config.yaml` | 项目元信息、工作流阶段、插件目录 |
| 工作流配置 | `.claude/config/workflows-config.yaml` | 4 种工作流定义 + 转换规则 + Hooks |
| Skills 配置 | `.claude/config/skills-config.yaml` | Skill 参数配置 |
| 插件注册表 | `plugins/plugin-registry.json` | 21 个插件的注册声明 |
| 角色注册表 | `.claude/agents/role-registry.yaml` | 角色分类、别名、标签映射 |
| MCP 注册表 | `.claude/core/mcp/registry.yaml` | MCP 协议端点配置 |
| 插件契约 | `plugins/contracts/plugin-interface.js` | 4 种插件基类定义 |
| Claude 设置 | `.claude/settings.json` | Hooks 注册到 Claude Code |

---

> **文档维护说明**: 本文档基于 v3.0 插件化架构生成，如插件发生变更，请同步更新本文档中对应的流程描述和代码引用。
