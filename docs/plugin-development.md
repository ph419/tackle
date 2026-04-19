# 插件开发指南

本指南介绍如何为 Tackle Harness 开发自定义插件。Tackle Harness 是一个基于插件的 AI Agent 工作流框架，支持四种插件类型：Skill、Hook、Validator 和 Provider。

## 目录

- [插件类型概述](#插件类型概述)
- [plugin.json Schema](#pluginjson-schema)
- [开发 Skill 插件](#开发-skill-插件)
- [开发 Hook 插件](#开发-hook-插件)
- [开发 Validator 插件](#开发-validator-插件)
- [开发 Provider 插件](#开发-provider-插件)
- [依赖声明与消费](#依赖声明与消费)
- [注册插件](#注册插件)
- [测试自定义插件](#测试自定义插件)

## 插件类型概述

| 类型 | 用途 | 输出文件 | 触发方式 |
|------|------|----------|----------|
| **Skill** | 可执行的工作流技能 | skill.md | 用户请求或关键词 |
| **Hook** | 生命周期钩子（PreToolUse/PostToolUse） | index.js | 工具/技能执行前后 |
| **Validator** | 输出验证器 | index.js | 手动或构建时触发 |
| **Provider** | 能力提供者（运行时服务） | index.js | 其他插件依赖注入 |

## plugin.json Schema

每个插件必须包含 `plugin.json` 定义文件，位于插件目录下：

```json
{
  "name": "plugin-name",
  "version": "1.0.0",
  "type": "skill|hook|validator|provider",
  "description": "插件描述",
  "dependencies": ["provider:state-store"],
  "provides": ["skill:plugin-name"],
  "config": {},
  "metadata": {}
}
```

### 字段说明

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | 插件唯一标识（kebab-case） |
| `version` | string | ✅ | 语义化版本号 |
| `type` | string | ✅ | 插件类型：`skill`、`hook`、`validator`、`provider` |
| `description` | string | ✅ | 插件功能描述 |
| `triggers` | string[] | ❌ | 触发关键词列表（主要用于 Skill 插件） |
| `dependencies` | string[] | ❌ | 依赖的 provider 或插件 |
| `provides` | string[] | ❌ | 此插件提供的能力标识 |
| `config` | object | ❌ | 默认配置值 |
| `metadata` | object | ❌ | 额外元数据（如触发器、目标等） |

## 开发 Skill 插件

Skill 插件是最常见的插件类型，为 Claude Code 提供可执行的工作流能力。

### 目录结构

```
plugins/core/skill-example/
├── plugin.json
└── skill.md
```

### plugin.json 示例

```json
{
  "name": "skill-example",
  "version": "1.0.0",
  "type": "skill",
  "description": "示例 Skill 插件",
  "triggers": ["示例", "example", "sample"],
  "dependencies": ["provider:state-store"],
  "provides": ["skill:example"],
  "metadata": {
    "stage": "execution",
    "requiresPlanMode": false,
    "gatedByHuman": false,
    "gatedByCode": false
  },
  "config": {
    "timeout": 30000
  }
}
```

### skill.md 模板

```markdown
# Example Skill (示例技能)

技能简短描述。

## When to Use

- 场景 1：描述何时触发此技能
- 场景 2：另一个触发场景

## 核心流程

### Step 1: 第一步

描述第一步的操作。

### Step 2: 第二步

描述第二步的操作。

## 验收标准

- [ ] 标准 1
- [ ] 标准 2

## 示例

### 输入
```
用户输入示例
```

### 输出
```
期望的输出示例
```
```

## 开发 Hook 插件

Hook 插件在工具或技能执行前后介入，用于实现权限控制、状态管理等功能。

### 目录结构

```
plugins/core/hook-example/
├── plugin.json
└── index.js
```

### plugin.json 示例

```json
{
  "name": "hook-example",
  "version": "1.0.0",
  "type": "hook",
  "description": "示例 Hook 插件",
  "dependencies": ["provider:state-store"],
  "config": {
    "priority": 100
  }
}
```

### index.js 模板

```javascript
'use strict';

var { HookPlugin } = require('../../contracts/plugin-interface');

/**
 * Example Hook
 *
 * 说明：这是一个示例 Hook 插件
 * 触发：PreToolUse 或 PostToolUse
 */
function ExampleHook() {
  HookPlugin.call(this);

  this.name = 'hook-example';
  this.version = '1.0.0';
  this.type = 'hook';
  this.description = '示例 Hook 插件';

  // Hook 触发器配置
  this.trigger = {
    event: 'PreToolUse',  // 或 'PostToolUse'
    tools: ['Edit', 'Write'],  // 可选：过滤特定工具
    skills: []  // 可选：过滤特定技能
  };

  this.priority = 100;  // 数字越小优先级越高
}

// 继承 HookPlugin
ExampleHook.prototype = Object.create(HookPlugin.prototype);
ExampleHook.prototype.constructor = ExampleHook;

/**
 * Hook 处理函数
 * @param {object} context - hook 上下文
 * @returns {Promise<{ allowed: boolean, reason?: string, stateChanges?: object[] }>}
 */
ExampleHook.prototype.handle = async function(context) {
  var event = context.event;
  var tool = context.tool;

  // 实现你的逻辑

  return {
    allowed: true,
    reason: '允许执行'
  };
};

module.exports = ExampleHook;
```

## 开发 Validator 插件

Validator 插件用于验证输出、检查文档一致性等。

### 目录结构

```
plugins/core/validator-example/
├── plugin.json
└── index.js
```

### plugin.json 示例

```json
{
  "name": "validator-example",
  "version": "1.0.0",
  "type": "validator",
  "description": "示例验证器",
  "dependencies": [],
  "provides": ["validator:example"],
  "metadata": {
    "targets": ["build", "manual"],
    "blocking": true
  },
  "config": {}
}
```

### index.js 模板

```javascript
'use strict';

var fs = require('fs');
var path = require('path');
var { ValidatorPlugin } = require('../../contracts/plugin-interface');

/**
 * Example Validator
 *
 * 说明：这是一个示例验证器
 * 用途：验证特定条件
 */
function ExampleValidator(options) {
  ValidatorPlugin.call(this);

  this.name = 'validator-example';
  this.version = '1.0.0';
  this.type = 'validator';
  this.description = '示例验证器';

  this.targets = ['build', 'manual'];
  this.blocking = true;

  this.projectRoot = options && options.projectRoot || process.cwd();
}

// 继承 ValidatorPlugin
ExampleValidator.prototype = Object.create(ValidatorPlugin.prototype);
ExampleValidator.prototype.constructor = ExampleValidator;

/**
 * 验证函数
 * @param {object} context - 验证上下文
 * @returns {Promise<{ passed: boolean, errors: object[], warnings: object[] }>}
 */
ExampleValidator.prototype.validate = async function(context) {
  var errors = [];
  var warnings = [];

  // 实现你的验证逻辑

  return {
    passed: errors.length === 0,
    errors: errors,
    warnings: warnings
  };
};

module.exports = ExampleValidator;
```

## 开发 Provider 插件

Provider 插件为其他插件提供运行时能力，如状态存储、角色管理等。

### 目录结构

```
plugins/core/provider-example/
├── plugin.json
└── index.js
```

### plugin.json 示例

```json
{
  "name": "provider-example",
  "version": "1.0.0",
  "type": "provider",
  "description": "示例 Provider",
  "dependencies": [],
  "provides": ["provider:example"],
  "config": {}
}
```

### index.js 模板

```javascript
'use strict';

var { ProviderPlugin } = require('../../contracts/plugin-interface');

/**
 * Example Provider
 *
 * 说明：这是一个示例 Provider
 * 提供：example 能力
 */
function ExampleProvider() {
  ProviderPlugin.call(this);

  this.name = 'provider-example';
  this.version = '1.0.0';
  this.type = 'provider';
  this.description = '示例 Provider';

  this.provides = 'provider:example';
}

// 继承 ProviderPlugin
ExampleProvider.prototype = Object.create(ProviderPlugin.prototype);
ExampleProvider.prototype.constructor = ExampleProvider;

/**
 * 工厂函数：创建 provider 实例
 * @param {PluginContext} context
 * @returns {Promise<object>}
 */
ExampleProvider.prototype.factory = async function(context) {
  // 返回 provider 实例对象
  return {
    // provider 方法
    doSomething: function() {
      return 'result';
    }
  };
};

module.exports = ExampleProvider;
```

## 依赖声明与消费

### 声明依赖

在 `plugin.json` 中声明依赖：

```json
{
  "dependencies": [
    "provider:state-store",
    "provider:role-registry",
    "provider:memory-store"
  ]
}
```

### 消费依赖

在 `index.js` 中通过 `PluginContext` 获取依赖：

```javascript
/**
 * 激活时注入依赖
 */
MyPlugin.prototype.onActivate = async function(context) {
  // 获取 provider
  var stateStore = await context.getProvider('provider:state-store');
  var roleRegistry = await context.getProvider('provider:role-registry');

  // 获取其他插件
  var anotherPlugin = context.getPlugin('another-plugin-name');

  // 使用 logger
  context.logger.info('Plugin activated');
};

/**
 * 执行时使用依赖
 */
MyPlugin.prototype.execute = async function(context, args) {
  var stateStore = await context.getProvider('provider:state-store');

  // 读取状态
  var value = await stateStore.get('my.key');

  // 写入状态
  await stateStore.set('my.key', 'new-value');

  return { success: true };
};
```

## 注册插件

### 1. 创建插件文件

在 `plugins/core/` 下创建插件目录和文件：

```
plugins/core/my-skill/
├── plugin.json
└── skill.md  (或 index.js)
```

### 2. 更新注册表

编辑 `plugins/plugin-registry.json`，在 `plugins` 数组中追加新插件条目（保留已有插件）：

```json
{
  "version": "1.0.0",
  "plugins": [
    {
      "name": "my-skill",
      "source": "my-skill",
      "enabled": true,
      "config": {}
    }
  ]
}
```

### 3. 构建插件

```bash
node bin/tackle.js build
```

构建成功后：
- Skill 插件：生成 `.claude/skills/my-skill/skill.md`
- Hook 插件：更新 `.claude/settings.json` hooks 配置
- Validator/Provider 插件：内部注册，无文件输出

## 测试自定义插件

### 验证插件格式

```bash
node bin/tackle.js validate
```

检查所有 `plugin.json` 的格式和必需字段。

### 测试 Skill 插件

1. 构建插件：`node bin/tackle.js build`
2. 在 Claude Code 中触发技能（使用 triggers 中定义的关键词）
3. 观察执行结果是否符合预期

### 测试 Hook 插件

1. 构建插件：`node bin/tackle.js build`
2. 触发 hook 监听的工具或技能
3. 检查 hook 是否正确介入

### 测试 Validator 插件

```javascript
// 手动测试脚本
var Validator = require('./plugins/core/validator-example/index.js');
var v = new Validator({ projectRoot: process.cwd() });
var result = await v.validate();
console.log(result);
```

### 测试 Provider 插件

```javascript
// 手动测试脚本
var Provider = require('./plugins/core/provider-example/index.js');
var p = new Provider();
var instance = await p.factory(context);
console.log(instance.doSomething());
```

## 常见问题

### Q: 如何调试插件？

A: 使用 `context.logger.debug()` 输出调试信息，或使用 `console.log` 进行临时调试。

### Q: 插件依赖如何解析？

A: 依赖在插件激活时自动注入，通过 `context.getProvider()` 获取。环形依赖会被检测并报错。

### Q: 如何禁用插件？

A: 在 `plugin-registry.json` 中将插件的 `enabled` 设为 `false`。

### Q: Skill 和 Hook 的区别？

A: Skill 是用户主动调用的功能模块；Hook 是被动触发的生命周期监听器。

## 相关文档

- [安装与快速入门](installation.md)
- [CLAUDE.md](../CLAUDE.md) - 项目指南
- [plugin-interface.js](../plugins/contracts/plugin-interface.js) - 插件接口定义
