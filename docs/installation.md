# 安装与快速入门指南

本指南将帮助你在 5 分钟内完成 Tackle Harness 的安装、配置和首次运行。

## 目录

- [系统要求](#系统要求)
- [安装步骤](#安装步骤)
- [首次配置](#首次配置)
- [运行第一个工作流](#运行第一个工作流)
- [验证安装](#验证安装)
- [常用命令](#常用命令)
- [下一步](#下一步)

## 系统要求

- **Node.js**: >= 18.0.0
- **操作系统**: Windows、macOS 或 Linux
- **Claude Code**: 已安装并配置

## 安装步骤

### 1. 安装 npm 包

在项目目录中运行：

```bash
npm install tackle-harness
```

或全局安装：

```bash
npm install -g tackle-harness
```

### 2. 验证安装

```bash
npx tackle-harness --help
```

如果显示帮助信息，说明安装成功。

## 首次配置

### 方法一：自动配置（推荐）

运行 init 命令自动创建配置文件：

```bash
npx tackle-harness init
```

此命令会：
- 创建 `.claude/` 目录
- 创建 `.claude/config/` 目录
- 生成默认的 `harness-config.yaml` 配置文件
- 构建所有插件到 `.claude/skills/`

### 方法二：手动配置

#### 1. 创建目录结构

```bash
mkdir -p .claude/config
mkdir -p .claude/skills
mkdir -p .claude/hooks
```

#### 2. 复制配置模板

如果使用本地开发版本，从模板复制配置：

```bash
cp node_modules/tackle-harness/templates/harness-config.yaml .claude/config/
```

#### 3. 构建插件

```bash
npx tackle-harness build
```

## 运行第一个工作流

### 1. 启动 Claude Code

在项目目录中启动 Claude Code：

```bash
claude
```

### 2. 触发技能

在 Claude Code 中输入：

```
创建任务：实现一个简单的登录功能
```

或者使用其他触发词：

```
/skill-task-creator
```

### 3. 观察 AI 响应

Claude Code 将：
1. 进入 Plan 模式分析任务
2. 创建工作包文档
3. 等待你的确认

### 4. 确认执行

输入 "确认创建" 或选择相应的确认选项。

### 5. 继续工作流

任务创建后，可以继续执行：

```
执行任务 WP-XXX
```

或使用完整的技能：

```
/skill-agent-dispatcher
```

## 验证安装

### 检查插件

```bash
npx tackle-harness validate
```

应该看到类似输出：

```
=== Validation Report ===
Plugins checked: 19
Errors: 0
Warnings: 0

Validation PASSED
```

### 检查构建输出

确认以下文件已生成：

```bash
# 检查 skills 目录
ls .claude/skills/

# 应该看到类似输出：
# skill-task-creator
# skill-batch-task-creator
# skill-split-work-package
# ...

# 检查 hooks 目录
ls .claude/hooks/

# 应该看到：
# hook-skill-gate
# hook-session-start
```

### 检查配置

```bash
cat .claude/settings.json
```

应该包含 hooks 配置和技能路径。

## 常用命令

| 命令 | 说明 |
|------|------|
| `tackle-harness` | 构建所有插件（默认命令） |
| `tackle-harness build` | 同上，构建所有插件 |
| `tackle-harness validate` | 验证插件格式 |
| `tackle-harness validate-config` | 验证 harness-config.yaml |
| `tackle-harness init` | 首次配置（build + 生成配置） |
| `tackle-harness status` | 显示构建状态和插件统计 |
| `tackle-harness config` | 显示/验证当前配置 |
| `tackle-harness list` | 列出所有已注册插件 |
| `tackle-harness version` | 显示版本信息 |
| `tackle-harness --root <path>` | 指定目标项目路径 |

### 示例

```bash
# 构建当前项目
npx tackle-harness build

# 构建指定项目
npx tackle-harness build --root /path/to/project

# 验证插件
npx tackle-harness validate

# 查看帮助
npx tackle-harness --help
```

## 配置文件说明

### harness-config.yaml

主配置文件位于 `.claude/config/harness-config.yaml`，包含以下配置：

- **context_window**: 上下文窗口管理
- **workflow**: 工作流定义
- **roles**: 角色系统
- **memory**: 记忆系统
- **mcp**: MCP 服务器配置

详见配置文件内的注释说明。

### settings.json

Claude Code 设置文件，由 `tackle-harness build` 自动更新，包含：

- **hooks**: 生命周期钩子配置
- **skills**: 技能路径映射

### plugin-registry.json

插件注册表，定义所有可用插件及其状态。

## 可用技能列表

安装完成后，以下技能立即可用：

| 技能 | 触发词 | 说明 |
|------|--------|------|
| task-creator | 创建任务、新建任务 | 创建工作包定义 |
| batch-task-creator | 批量创建任务 | 批量创建工作包 |
| split-work-package | 拆分工作包 | 拆分现有工作包 |
| progress-tracker | 记录进度、保存进度 | 管理项目进度 |
| team-cleanup | 清理团队 | 清理孤立 agent 团队 |
| human-checkpoint | 人工检查、检查点 | 人工审核节点 |
| agent-dispatcher | 批量执行、并行执行 | 调度子代理执行 |
| workflow-orchestrator | 开始工作流、执行流程 | 运行完整工作流 |
| role-manager | 查看角色、匹配角色 | 角色管理 |
| checklist | 运行检查、执行清单 | 质量检查清单 |
| completion-report | 汇报结果、完成报告 | 生成完成报告 |
| experience-logger | 总结经验、记录经验 | 记录经验教训 |

## 故障排除

### 问题：插件未出现在技能列表

**解决方案**：
1. 运行 `npx tackle-harness build` 重新构建
2. 检查 `.claude/settings.json` 是否正确更新
3. 重启 Claude Code

### 问题：配置文件未生成

**解决方案**：
1. 确保有写入权限
2. 手动创建 `.claude/config/` 目录
3. 从模板复制配置文件

### 问题：验证失败

**解决方案**：
1. 检查 `plugin.json` 格式是否正确
2. 确保所有必需字段存在
3. 查看具体错误信息进行修复

## 下一步

- 阅读插件开发指南了解如何开发自定义插件
- 查看 CLAUDE.md 了解项目架构
- 尝试不同的技能和配置选项

## 获取帮助

- 在 Claude Code 中输入 `/help` 获取使用帮助
- 运行 `npx tackle-harness help` 查看 CLI 命令列表
