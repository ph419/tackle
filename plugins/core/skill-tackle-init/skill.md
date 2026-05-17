---
name: tackle-init
description: Use when user says '初始化 tackle', 'init tackle', 'setup tackle', or wants to initialize tackle-harness in the current project directory
---

# Tackle Harness 初始化

在当前项目目录中初始化 tackle-harness。

## 背景

全局安装 `tackle-harness` 后，所有技能和 hooks 已经在 `~/.claude/` 下全局可用。项目初始化只需要创建配置文件即可使用这些全局技能。

## 执行步骤

1. 确认 `tackle-harness` 已全局安装：
   ```bash
   npm list -g tackle-harness
   ```
   如果未安装，先执行：
   ```bash
   npm install -g tackle-harness
   ```

2. 在项目目录中运行初始化命令：
   ```bash
   tackle-harness init
   ```

3. 初始化会创建以下配置文件：
   - `.claude/config/harness-config.yaml` — 主配置文件（包含 context window 设置）
   - `.claude/harness-manifest.json` — 项目级插件激活清单
   - `.claude/settings.json` — Claude Code 设置（hooks 注册）

4. 如果项目已有旧版结构（项目级 skills/hooks 目录），初始化会自动清理并迁移提示。

## 验证

初始化完成后，项目目录应该只包含配置文件，不包含技能或 hooks 文件：

```bash
# 应该看到这些文件
ls -la .claude/
# config/
# harness-manifest.json
# settings.json
# CLAUDE.md（包含 plan-mode 规则）

# 不应该看到这些目录
# skills/  ← 已迁移到全局
# hooks/   ← 已迁移到全局
```

## 使用

配置完成后，所有 tackle-harness 技能立即在当前项目可用。无需额外构建步骤。

## 迁移

如果是旧项目升级，可以运行：
```bash
tackle-harness migrate
```
来清理旧的项目级技能和 hooks 文件。
