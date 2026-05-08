---
name: tackle-init
description: Use when user says '初始化 tackle', 'init tackle', 'setup tackle', or wants to initialize tackle-harness in the current project directory
---

# Tackle Harness 初始化

在当前项目目录中初始化 tackle-harness。

## 执行步骤

1. 检查当前目录是否已初始化（`.claude/skills/` 是否存在且包含技能文件）
2. 如果已初始化，告知用户当前状态和已安装的技能数量，询问是否重新初始化
3. 如果未初始化，执行以下操作：

```bash
tackle-harness init --root <当前项目目录>
```

4. 验证初始化结果：
   - 检查 `.claude/skills/` 目录是否存在且包含 13 个技能
   - 检查 `.claude/hooks/` 目录是否存在且包含 2 个 hook
   - 检查 `.claude/settings.json` 是否已更新 hooks 注册
   - 检查 `.claude/harness-manifest.json` 是否已创建
   - 检查 `.claude/config/harness-config.yaml` 是否已创建

5. 输出初始化摘要，告知用户可以开始使用

## 注意事项

- 使用 `--root` 指定当前工作目录，不要假设路径
- 如果 `tackle-harness` 命令不可用，提示用户先全局安装：`npm install -g tackle-harness`
- 初始化不会覆盖已有的 `harness-config.yaml` 和 `harness-manifest.json`
