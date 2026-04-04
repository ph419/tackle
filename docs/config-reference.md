# 配置参考

本文档提供 AI Agent Harness 所有配置文件的完整参考。

## 目录

- [harness-config.yaml](#harness-config-yaml)
- [skills-config.yaml](#skills-config-yaml)
- [workflows-config.yaml](#workflows-config-yaml)
- [role-registry.yaml](#role-registry-yaml)

---

## harness-config.yaml

主配置文件，定义项目的核心设置。

### 配置结构

```yaml
# 项目元信息
project:
  name: "项目名称"
  version: "版本号"
  description: "项目描述"
  author: "作者"
  license: "许可证"

# 工作流阶段定义
workflow:
  default:
    name: "默认工作流名称"
    stages:
      - id: "stage-id"
        name: "阶段名称"
        skills: ["skill1", "skill2"]
        auto_advance: false
        checkpoint: true

# 角色系统配置
roles:
  roles_dir: ".claude/agents/roles"
  registry_file: ".claude/agents/role-registry.yaml"
  defaults:
    planner: "planner"
    implementer: "implementer"

# 记忆系统配置
memory:
  storage_dir: ".claude/agents/memories"
  format: "yaml"
  auto_extraction:
    enabled: true
    trigger_keywords: ["pattern", "solution"]
    min_confidence: 0.7

# MCP 协议配置
mcp:
  config_dir: ".claude/mcp/servers"
  servers:
    - name: "server-name"
      type: "stdio | http"
      enabled: true

# 中间件配置
middleware:
  chain:
    - "validator"
    - "logger"
    - "rate-limiter"
```

### 配置项说明

| 配置项 | 类型 | 必需 | 描述 |
|--------|------|------|------|
| project | object | 是 | 项目元信息 |
| workflow | object | 是 | 工作流定义 |
| roles | object | 否 | 角色系统配置 |
| memory | object | 否 | 记忆系统配置 |
| mcp | object | 否 | MCP 协议配置 |
| middleware | object | 否 | 中间件配置 |
| context_window | object | 否 | 上下文窗口管理配置 |

---

## context_window 配置节

上下文窗口管理配置，控制任务创建技能在分析大文件时的分块读取行为。

### 配置结构

```yaml
context_window:
  max_tokens: 200000
  safety_margin: 40000
  chunk_lines: 500
  strategy: "auto"
  thresholds:
    small: 200
    medium: 800
    large: 2000
```

### 配置项说明

| 配置项 | 类型 | 默认值 | 描述 |
|--------|------|--------|------|
| max_tokens | number | 200000 | 模型上下文窗口大小（token 数近似值） |
| safety_margin | number | 40000 | 为指令和输出预留的 token 数，防止上下文溢出 |
| chunk_lines | number | 500 | 分块读取时每次 Read 调用的最大行数 |
| strategy | string | "auto" | 溢出处理策略。`auto` 根据文件类型和大小自动选择 |
| thresholds | object | - | 文件大小阈值（行数），决定读取策略 |
| thresholds.small | number | 200 | 小文件阈值。≤ 此值直接读取 |
| thresholds.medium | number | 800 | 中文件阈值。此值内分块读取 |
| thresholds.large | number | 2000 | 大文件阈值。超过此值优先 Grep 扫描 |

### 工作原理

构建时，`harness-build.js` 读取此配置并注入到每个 skill.md 的 `<!-- CONTEXT-CONFIG -->` 注释块中。技能在深度模式下执行时根据这些参数决定读取策略：

- **小文件** (≤ 200行): 直接用 Read 工具读取
- **中文件** (200-800行): 用 Read(offset, limit) 分块读取
- **大文件** (> 800行): 先 Grep 扫描定位，再定向读取
- **多文件超预算**: 按优先级排序，高优读全文，低优用 Grep

---

## skills-config.yaml

Skills 触发词配置，定义技能的触发规则。

### 配置结构

```yaml
skills:
  - id: "skill-id"
    name: "技能名称"
    trigger_keywords:
      - "关键词1"
      - "关键词2"
    description: "技能描述"

groups:
  development:
    - "coder"
    - "reviewer"

priority:
  - level: 1
    skills: ["planner"]
```

### 配置项说明

| 配置项 | 类型 | 必需 | 描述 |
|--------|------|------|------|
| skills | array | 是 | 技能定义列表 |
| groups | object | 否 | 技能分组 |
| priority | array | 否 | 优先级定义 |

---

## workflows-config.yaml

工作流阶段配置，定义工作流的执行流程。

### 配置结构

```yaml
workflows:
  - id: "workflow-id"
    name: "工作流名称"
    stages:
      - id: "stage-id"
        name: "阶段名称"
        skills: ["skill1"]
        auto_advance: true
        checkpoint: false
        entry_hooks: ["hook1"]
        exit_hooks: ["hook2"]

transitions:
  auto_advance:
    - from: "stage1"
      to: "stage2"
      condition: "condition"

hooks:
  entry_hooks:
    - id: "hook-id"
      description: "钩子描述"
      command: "command"
```

### 配置项说明

| 配置项 | 类型 | 必需 | 描述 |
|--------|------|------|------|
| workflows | array | 是 | 工作流定义列表 |
| transitions | object | 否 | 阶段转换规则 |
| hooks | object | 否 | 钩子定义 |

---

## role-registry.yaml

角色注册表，定义所有可用角色。

### 配置结构

```yaml
version: "1.0.0"

categories:
  meta:
    description: "元角色"
    roles: ["coordinator", "executor"]

role_files:
  - path: "roles/meta/coordinator.yaml"

aliases:
  协调者: coordinator

tag_to_role:
  "[架构设计]":
    - architect
```

### 配置项说明

| 配置项 | 类型 | 必需 | 描述 |
|--------|------|------|------|
| version | string | 是 | 注册表版本 |
| categories | object | 是 | 角色分类 |
| role_files | array | 是 | 角色文件列表 |
| aliases | object | 否 | 中文别名 |
| tag_to_role | object | 否 | 标签映射 |

---

## 环境变量

配置支持环境变量注入：

```yaml
mcp:
  servers:
    - name: "github"
      env:
        GITHUB_TOKEN: "${GITHUB_TOKEN}"
```

## 配置继承

子配置可以继承父配置：

```yaml
extends: "base"

# 覆盖父配置的值
workflow:
  default:
    stages: []
```

## 配置验证

使用 `--validate` 参数验证配置：

```bash
claude-harness --validate
```
