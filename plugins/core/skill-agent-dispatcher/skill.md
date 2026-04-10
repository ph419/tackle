---
name: agent-dispatcher
description: Use when user says "批量执行", "并行执行", "调度子代理", or needs to execute multiple work packages using Agent subagents. Analyzes dependencies and dispatches tasks in parallel or sequential order.
---

# Agent Dispatcher (Agent Teams 版)

基于 **Claude Code Agent Teams** 机制的子代理批量任务调度技能，支持角色赋能和记忆注入。

## When to Use

**触发词**:
- "批量执行" / "并行执行"
- "调度子代理" / "派发任务"
- "执行工作包 WP-XXX, WP-YYY"
- "开始批量任务"

## Quick Reference

| 场景 | 执行方式 |
|------|----------|
| 无依赖的多个工作包 | 并行执行 (每 WP 一个专用 Teamee) |
| 有依赖链的工作包 | blockedBy 阻塞 + 依赖解除后按需创建 Teamee |
| 混合依赖 | 监控循环动态创建 + 即时销毁 |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Team Lead (主 Agent)                    │
│                                                             │
│  1. 解析工作包 → 分析依赖                                     │
│  2. TeamCreate 创建团队                                      │
│  3. TaskCreate 创建任务 + 设置 blockedBy                      │
│  4. 角色匹配 → 预计算每个 WP 的角色和记忆                      │
│  5. 监控循环:                                                │
│     - 检测 newly-unblocked 任务 → 按需创建专用 Teamee (1:1)  │
│     - 检测已完成的任务 → 即时销毁对应 Teamee                   │
│     - 维护映射表 {task_id → teamee_name}                     │
│  6. 全部完成后 TeamDelete                                     │
│  7. 经验提取 + completion-report                              │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
  ┌──────────┐          ┌──────────┐          ┌──────────┐
  │ Teamee A │          │ Teamee B │          │ Teamee C │
  │ WP-037   │          │ WP-038   │          │ WP-039   │
  │ 专用绑定  │          │ 专用绑定  │          │ 专用绑定  │
  └────┬─────┘          └────┬─────┘          └────┬─────┘
       │ 已完成              │ 执行中               │ blockedBy #2
       │ 即时销毁            │                     │ 等待创建
       ▼                     ▼                     ▼
              ┌───────────────────────────────┐
              │     共享 Task List            │
              │  Task #1: WP-037 (completed)  │
              │  Task #2: WP-038 (in_progress)│
              │  Task #3: WP-039 (blockedBy #2)│
              └───────────────────────────────┘
```

---

## Flow

```dot
digraph dispatcher_v3 {
    rankdir=TB;

    // 准备阶段
    "解析工作包清单" [shape=box];
    "分析依赖关系" [shape=box];
    "检测循环依赖" [shape=diamond];

    // 团队创建
    "TeamCreate 创建团队" [shape=box, style=filled, fillcolor=lightblue];
    "TaskCreate 创建任务" [shape=box, style=filled, fillcolor=lightblue];
    "设置 blockedBy 依赖" [shape=box];

    // 角色匹配
    "角色匹配 (预计算)" [shape=box, style=filled, fillcolor=lightyellow];
    "读取角色定义" [shape=box];
    "注入专属记忆" [shape=box];

    // 监控循环
    "监控循环: TaskList" [shape=diamond, style=filled, fillcolor=orange];
    "检测 newly-unblocked 任务" [shape=box];
    "为可用任务创建专用 Teamee" [shape=box, style=filled, fillcolor=orange];
    "预分配 owner (TaskUpdate)" [shape=box];
    "Teamee 执行单一任务" [shape=box];
    "TaskUpdate 标记 completed" [shape=box];

    // 即时销毁
    "检测已完成任务" [shape=box];
    "发送 shutdown_request" [shape=box, style=filled, fillcolor=red];
    "等待 shutdown_response" [shape=box];
    "从映射表移除" [shape=box];

    // 循环判断
    "所有任务 completed?" [shape=diamond];
    "超时?" [shape=diamond];

    // 收尾
    "TeamDelete 清理团队" [shape=box];
    "经验提取" [shape=box, style=filled, fillcolor=lightgreen];
    "生成执行报告" [shape=box];

    // 流程连接
    "解析工作包清单" -> "分析依赖关系";
    "分析依赖关系" -> "检测循环依赖";
    "检测循环依赖" -> "TeamCreate 创建团队" [label="无循环"];
    "检测循环依赖" -> "报错退出" [label="有循环", style=dashed];

    "TeamCreate 创建团队" -> "TaskCreate 创建任务";
    "TaskCreate 创建任务" -> "设置 blockedBy 依赖";
    "设置 blockedBy 依赖" -> "角色匹配 (预计算)";

    "角色匹配 (预计算)" -> "读取角色定义";
    "读取角色定义" -> "注入专属记忆";
    "注入专属记忆" -> "监控循环: TaskList";

    "监控循环: TaskList" -> "检测 newly-unblocked 任务";
    "检测 newly-unblocked 任务" -> "为可用任务创建专用 Teamee" [label="有可用任务"];
    "为可用任务创建专用 Teamee" -> "预分配 owner (TaskUpdate)";
    "预分配 owner (TaskUpdate)" -> "Teamee 执行单一任务";
    "Teamee 执行单一任务" -> "TaskUpdate 标记 completed";

    "监控循环: TaskList" -> "检测已完成任务";
    "检测已完成任务" -> "发送 shutdown_request" [label="有新完成"];
    "发送 shutdown_request" -> "等待 shutdown_response";
    "等待 shutdown_response" -> "从映射表移除";

    "监控循环: TaskList" -> "所有任务 completed?";
    "所有任务 completed?" -> "TeamDelete 清理团队" [label="是"];
    "所有任务 completed?" -> "超时?" [label="否"];
    "超时?" -> "监控循环: TaskList" [label="否"];
    "超时?" -> "TeamDelete 清理团队" [label="是"];

    "TeamDelete 清理团队" -> "经验提取";
    "经验提取" -> "生成执行报告";
}
```

---

## Step-by-Step Implementation

### Step 1: 解析工作包 + 分析依赖

```
1. 读取 task.md 获取下一个可用 WP 编号
2. 提取待执行工作包的依赖关系
3. 构建依赖图，检测循环依赖
4. 确定执行顺序（拓扑排序）
```

### Step 2: 创建团队

```
TeamCreate:
  team_name: "batch-{YYYYMMDD}-{work-package-ids}"
  description: "批量执行 {WP-XXX, WP-YYY}"
```

**命名规范**：
- 单工作包: `batch-20260314-WP073`
- 批量工作包: `batch-20260314-WP073-075`

### Step 3: 创建任务 + 设置依赖

```
# 为每个工作包创建 Task

TaskCreate:
  subject: "WP-037: 凝视区域形状升级"
  description: |
    ## 📖 必读：工作包文档

    **执行前请先阅读工作包文档获取完整上下文：**
    - 文档路径: `docs/wp/WP-037.md`
    - 包含: 问题分析、实施计划、关键文件、验收标准

    ---

    {工作包简要描述}
  status: pending

# 设置依赖关系
TaskUpdate:
  taskId: "{依赖任务的 ID}"
  addBlockedBy: ["{被依赖任务的 ID}"]
```

**⚠️ 重要**: description 必须包含工作包文档路径，让 Subagent 知道从哪里获取完整上下文！

### Step 4-5: 角色匹配 + 记忆准备

**📖 在执行此步骤前，读取角色与记忆参考文档：**
```
Read("plugins/core/skill-agent-dispatcher/roles-reference.md")
```

该文档包含：
- **Step 4**: 角色匹配算法（关键词/任务类型/模块标签加权评分）
- **Step 5**: 预计算角色和记忆的完整流程
- **角色赋能系统**: 核心角色表、领域角色表、角色文件位置
- **记忆注入机制**: 经验提取逻辑、动态数量、回退机制
- **经验沉淀闭环**: 执行完成后的经验提取流程

### Step 6: 初始创建 Teamee（首次可用任务）

<HARD-GATE>
Step 5 完成后，立即检查有哪些任务的 blockedBy 已满足。
为每个 initially-unblocked 的任务创建专用 Teamee。
不可跳过此步骤！
</HARD-GATE>

**⚠️ 重要**: 必须使用 `general-purpose` subagent_type！

不要使用 `Explore` 或其他只读 agent 类型，因为它们没有 SendMessage 工具，
无法响应 shutdown_request，会导致即时销毁流程失败。

```
# 初始化映射表
teamee_map = {}  # {task_id: teamee_name}

# 检查哪些任务在初始时就没有阻塞
tasks = TaskList()
for task in tasks:
    if task.status == "pending" and is_unblocked(task):
        # 从预计算结果获取角色信息
        assignment = wp_assignments[task.id]

        # 生成唯一的 Teamee 名称（包含 task_id 和 role）
        teamee_name = f"{assignment.role_id}-t{task.id}"

        # 预分配 owner
        TaskUpdate(taskId=task.id, owner=teamee_name)

        # 创建专用 Teamee
        Agent(
            name=teamee_name,
            team_name="{team_name}",
            subagent_type="general-purpose",  # 必须使用 general-purpose
            prompt=build_single_task_prompt(
                teamee_name=teamee_name,
                task_id=task.id,
                role_prompt=assignment.role_prompt,
                memories=assignment.memories,
                wp_doc_path=assignment.wp_doc_path
            )
        )

        # 记录映射关系
        teamee_map[task.id] = teamee_name
```

**为什么不能用 Explore agent**:
- Explore agent 的工具集: `All tools except Agent, ExitPlanMode, Edit, Write, NotebookEdit`
- 没有 Agent 工具 = 没有 SendMessage
- 无法发送 `shutdown_response` = 即时销毁失败 = 资源泄漏

### Step 6.5: 监控循环 (🔴 关键步骤 — 动态创建 + 即时销毁)

<HARD-GATE>
Lead Agent 必须进入监控循环，不可跳过！
此循环负责:
1. 检测 newly-unblocked 任务 → 按需创建专用 Teamee
2. 检测已完成任务 → 即时销毁对应 Teamee
3. 判断全部完成 → 退出循环
这是保证资源及时释放和依赖正确解析的核心机制。
</HARD-GATE>

```
# Lead Agent 监控循环
loop_interval = 30  # 秒
max_wait_time = 7200  # 2 小时
shutdown_timeout = 15  # 等待 Teamee shutdown 响应的超时

start_time = now()
while (now() - start_time) < max_wait_time:
    # ---- Phase A: 获取任务状态 ----
    tasks = TaskList()

    # ---- Phase B: 即时销毁已完成的 Teamee ----
    for task in tasks:
        if task.status == "completed" and task.id in teamee_map:
            teamee_name = teamee_map[task.id]
            print(f"任务 {task.id} 已完成，即时销毁 Teamee: {teamee_name}")

            # B1. 发送 shutdown_request
            SendMessage(to=teamee_name, message={
                "type": "shutdown_request",
                "reason": f"任务 {task.id} 已完成，释放资源",
                "request_id": f"shutdown-{task.id}-{timestamp()}"
            })

            # B3. 从映射表移除
            del teamee_map[task.id]
            print(f"Teamee {teamee_name} 已销毁并从映射表移除")

    # ---- Phase C: 按需创建 Teamee 处理 newly-unblocked 任务 ----
    for task in tasks:
        if task.status == "pending" and task.owner == "" and is_unblocked(task):
            # C1. 检查是否已有映射（防止重复创建）
            if task.id in teamee_map:
                continue

            # C2. 从预计算结果获取角色信息
            assignment = wp_assignments[task.id]
            teamee_name = f"{assignment.role_id}-t{task.id}"

            # C3. 预分配 owner
            TaskUpdate(taskId=task.id, owner=teamee_name)

            # C4. 创建专用 Teamee
            Agent(
                name=teamee_name,
                team_name="{team_name}",
                subagent_type="general-purpose",
                prompt=build_single_task_prompt(
                    teamee_name=teamee_name,
                    task_id=task.id,
                    role_prompt=assignment.role_prompt,
                    memories=assignment.memories,
                    wp_doc_path=assignment.wp_doc_path
                )
            )

            # C5. 记录映射关系
            teamee_map[task.id] = teamee_name
            print(f"为任务 {task.id} 创建专用 Teamee: {teamee_name}")

    # ---- Phase D: 判断退出条件 ----
    completed = count(status == "completed")
    total = len(tasks)

    if completed == total:
        print("所有任务完成，退出监控循环")
        break

    # Phase D2: 异常检测
    in_progress = count(status == "in_progress")
    pending = count(status == "pending")
    if pending > 0 and in_progress == 0 and len(teamee_map) == 0:
        print("异常: 有待处理任务但无活跃 Teamee 且无映射")
        break

    sleep(loop_interval)

# 超时处理
if (now() - start_time) >= max_wait_time:
    print("监控超时，强制执行清理")
    for task_id, teamee_name in teamee_map.items():
        SendMessage(to=teamee_name, message={
            "type": "shutdown_request",
            "reason": "监控超时，强制清理",
            "request_id": f"force-shutdown-{task_id}-{timestamp()}"
        })
```

**辅助函数 — 判断任务是否已解除阻塞**:
```
def is_unblocked(task):
    """检查任务的所有 blockedBy 依赖是否都已满足"""
    if not task.blockedBy:
        return True
    all_tasks = TaskList()
    for blocker_id in task.blockedBy:
        blocker = find_by_id(all_tasks, blocker_id)
        if blocker.status != "completed":
            return False
    return True
```

**监控循环关键特性**:
- **Phase B (即时销毁)** 在 Phase C (创建) 之前执行，确保资源先释放再分配
- 每次循环都检查 `teamee_map` 防止重复创建/重复销毁
- 异常检测同时检查 `teamee_map` 是否为空，避免误判

### Step 7: 清理团队

**📖 在执行此步骤前，读取清理参考文档：**
```
Read("plugins/core/skill-agent-dispatcher/cleanup-reference.md")
```

该文档包含：
- **权限要求**: Bash 工具权限配置建议
- **Step 7a-7h**: 完整清理流程（安全检查 → shutdown → TeamDelete → 验证）
- **Error Handling**: 循环依赖、Teamee 失败、超时等错误处理
- **Cleanup Guarantee**: 清理保障矩阵

---

## Teamee Prompt 模板

**📖 在创建 Teamee 时（Step 6 / Step 6.5），读取 Prompt 模板参考文档：**
```
Read("plugins/core/skill-agent-dispatcher/roles-reference.md")
```

`roles-reference.md` 底部包含完整的 Teamee Prompt 模板，用于 `build_single_task_prompt()` 构建。
模板要点：1:1 任务绑定、工作包文档优先阅读、完成后等待 shutdown_request、状态同步必须执行。

---

## 共享上下文机制

### 自动共享 (无需干预)

| 资源 | 共享方式 |
|------|----------|
| `CLAUDE.md` | 所有 Teamee 自动加载 |
| Skills | 继承 Lead 的 skills |
| MCP Servers | 共享相同的 MCP 配置 |
| 项目代码 | 共享同一工作目录 |

### 主动共享 (通过 SendMessage)

| 消息类型 | 用途 |
|----------|------|
| `message` | Lead ↔ Teamee 点对点通信 |
| `shutdown_request` | Lead 请求 Teamee 关闭 |

---

## Dependency Analysis

### 依赖图构建

1. **读取工作包清单** - 获取所有待执行工作包
2. **解析依赖声明** - 提取 `依赖: WP-XXX` 信息
3. **构建有向图** - 节点=工作包，边=依赖关系
4. **拓扑排序** - 确定执行顺序
5. **检测循环依赖** - 如有循环则报错

### 循环依赖检测

```
❌ 检测到循环依赖: WP-037 → WP-038 → WP-039 → WP-037
请手动解除依赖关系后重试。
```

---

## Execution Report

批量执行完成后生成汇总报告，存放到 `docs/reports/` 目录。

### 报告命名规范

```
docs/reports/{YYYY-MM-DD}_{工作包列表}_execution_report.md
```

### 报告内容模板

```markdown
# 批量执行报告

## 基本信息
- 团队名称: batch-20260314-WP073-075
- 执行日期: 2026-03-14
- 工作包: WP-073, WP-074, WP-075

## 执行总览

| Task ID | 工作包 | 角色 | 状态 | 依赖 | 说明 |
|---------|--------|------|------|------|------|
| #1 | WP-073 | godot-scene-expert | ✅ 完成 | - | - |
| #2 | WP-074 | godot-script-expert | ✅ 完成 | #1 | - |
| #3 | WP-075 | combat-ai-expert | ✅ 完成 | #2 | - |

## 详细结果
(每个 WP 的执行者、子任务完成情况、文件变更)

## 📁 文件变更汇总
新增: X 个 / 修改: Y 个 / 测试: Z 个

## 💡 新增经验
(如有新经验，已写入角色专属库)

---
报告生成时间: {timestamp}
```

---

## 拆分工作包执行支持

当工作包有子工作包时，agent-dispatcher 会自动识别并按依赖调度。

### 执行流程

```
1. 读取父工作包文档 (docs/wp/WP-XXX.md)
2. 检测拆分模式 (simple/standard/fine-grained)
3. 解析子工作包列表 + 依赖关系
4. 创建 Task List 任务 + 设置 blockedBy
5. 角色匹配 → 分配角色
6. 按依赖顺序调度执行
7. 验证关卡: verify 失败 → 停止后续; verify 通过 → 继续
```

### 拆分模式处理

| 模式 | 处理方式 |
|------|----------|
| **simple** | 不拆分，直接作为单个任务调度 |
| **standard** | 4 个子任务: impl → test → verify → review（依赖链） |
| **fine-grained** | 按模块拆分多个 impl，每个独立 test，最后统一 verify + review |

---

## Integration with Other Skills

| Skill | 集成点 |
|-------|--------|
| `role-manager` | 查看角色、手动匹配 |
| `human-checkpoint` | 批量执行前确认执行计划 |
| `completion-report` | 批量执行后生成报告 |
| `checklist` | 每个工作包完成后检查 |
| `experience-logger` | 批量执行后记录经验 |
| `task-creator` | 支持拆分工作包创建 |
| `batch-task-creator` | 支持批量拆分 |

---

## Important

1. **TeamCreate 是必须的** - 没有团队就没有共享 Task List
2. **blockedBy 自动阻塞** - 依赖机制由 Task List 自动处理
3. **Lead 按需分配 (1:1)** - 每个 WP 由 Lead 创建专用 Teamee 并预分配，禁止一个 Teamee 处理多个 WP
4. **即时销毁** - Teamee 完成任务后立即销毁释放资源，不等到全部完成
5. **角色匹配提升质量** - 专业角色比通用代理更高效
6. **记忆注入避免踩坑** - 从历史经验中学习
7. **经验沉淀形成闭环** - 每次执行都让角色更聪明
8. **🔴 TeamDelete 是强制的** - 无论成功/失败/超时，都必须执行清理！
9. **🔴 监控循环不可跳过** - Lead 必须进入 Step 6.5 监控循环，负责动态创建和即时销毁
