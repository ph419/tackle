# 最佳实践

> ⚠️ **本文档已过时，请勿作为参考**
>
> 本文档引用了已废弃的配置方式和概念，包括：
> - YAML workflow 配置文件（已由 skills-based 系统替代）
> - middleware 概念（架构中已不存在）
> - 早期配置格式（已大幅改动）
>
> **请参阅 [日常工作流指南](daily-workflow-guide.md) 获取最新的最佳实践与避坑指南。**
>
> 本文档保留用于历史参考，将在后续版本中完全移除。

本文档提供了使用 AI Agent Harness 的最佳实践建议。

## 目录

- [工作流使用](#工作流使用)
- [角色定义](#角色定义)
- [配置优化](#配置优化)
- [性能调优](#性能调优)

---

## 工作流使用

### 选择合适的工作流

| 场景 | 推荐工作流 |
|------|-----------|
| 常规开发 | standard-dev |
| 快速修复 | quick-fix |
| 代码审查 | code-review |
| 文档更新 | documentation |

### 检查点使用

```yaml
# 在关键阶段设置检查点
stages:
  - id: "verification"
    checkpoint: true  # 需要确认后继续
```

### 自定义工作流

根据项目需求自定义工作流阶段：

```yaml
workflows:
  - id: "my-workflow"
    name: "我的工作流"
    stages:
      - id: "custom-stage"
        name: "自定义阶段"
        skills: ["custom-skill"]
```

---

## 角色定义

### 角色粒度

- **避免过度细分**: 相似角色应该合并
- **保持专注**: 每个角色应该有明确的专业领域
- **合理继承**: 使用继承减少重复

### 好的角色定义

```yaml
# 好的定义：专注、清晰
id: "godot-scene-expert"
name: "Godot 场景专家"
expertise:
  - scene-system
  - node-tree
keywords:
  - "场景"
  - "scene"
```

### 不好的角色定义

```yaml
# 不好的定义：过于宽泛
id: "developer"
name: "开发者"
expertise: []  # 空的专业领域
keywords: []   # 没有关键词
```

### 角色命名约定

- 使用小写字母和连字符
- 名称应该清晰表达角色职责
- 专家角色以 `-expert` 结尾

---

## 配置优化

### 环境变量使用

敏感信息应该使用环境变量：

```yaml
# 不好的做法
mcp:
  servers:
    - name: "github"
      token: "ghp_xxxxxxxxx"  # 硬编码的敏感信息

# 好的做法
mcp:
  servers:
    - name: "github"
      env:
        GITHUB_TOKEN: "${GITHUB_TOKEN}"  # 环境变量
```

### 配置分离

将通用配置和项目特定配置分离：

```yaml
# base-config.yaml (通用)
project:
  version: "1.0.0"

# project-config.yaml (项目特定)
extends: "base-config"
project:
  name: "my-project"
```

### 条件配置

根据环境使用不同配置：

```yaml
development:
  debug: true

production:
  debug: false
  log_level: "warn"
```

---

## 性能调优

### 记忆提取优化

```yaml
memory:
  auto_extraction:
    enabled: true
    min_confidence: 0.8  # 提高阈值减少低质量记忆
    batch_size: 10       # 批处理提高效率
```

### 中间件优化

```yaml
middleware:
  # 按优先级排序
  chain:
    - name: "validator"
      priority: 100  # 高优先级先执行
    - name: "summarization"
      priority: 50
    - name: "logger"
      priority: 10
```

### MCP 连接池

```yaml
mcp:
  defaults:
    process_pool_size: 5  # 限制进程数量
    timeout: 30           # 设置超时
```

---

## 安全最佳实践

### 最小权限原则

```yaml
mcp:
  security:
    allowed_commands:
      - "npx"           # 只允许必要的命令
    forbidden_args:
      - "--insecure"    # 禁止不安全参数
```

### 敏感信息保护

- 使用环境变量存储敏感信息
- 不要在配置文件中硬编码密码
- 使用 `.gitignore` 排除敏感配置

---

## 调试技巧

### 启用调试模式

```yaml
development:
  debug: true
  verbose: true
  log_level: "debug"
```

### 查看中间件日志

```bash
./bin/harness --debug --log-level debug
```

### 验证配置

```bash
./bin/harness validate
```

---

## 团队协作

### 配置版本控制

- 所有配置文件应该纳入 Git
- 使用 `.gitignore` 排除敏感信息
- 记录配置变更原因

### 文档同步

- 配置变更时更新文档
- 使用 CHANGELOG.md 记录重要变更
- 保持 README.md 的时效性

---

## 常见陷阱

### 避免的配置错误

1. **循环依赖**: 角色不应该相互继承
2. **过度配置**: 不必要的配置会增加复杂性
3. **硬编码路径**: 使用相对路径或环境变量

### 示例

```yaml
# 不好的配置
roles:
  - id: "role-a"
    inherits: "role-b"
  - id: "role-b"
    inherits: "role-a"  # 循环依赖

# 好的配置
roles:
  - id: "role-a"
    inherits: "base"
  - id: "role-b"
    inherits: "base"
```
