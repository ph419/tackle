# API Reference

> Tackle Harness v0.1.x -- API 稳定性参考文档

本文档描述 Tackle Harness 的所有公共 API、实验性 API 和内部 API，帮助开发者判断哪些接口可安全依赖。

> **范围说明**：本文档覆盖 v0.1.x 奠定的插件框架 / 运行时核心（harness-build、plugin-loader、state-store 等）。v0.3.x 起的 **Agentic Loop 运行时模块**（`provider-loop-engine`、`loop-snapshot`、`reflection-evaluator`、`loop-coordinator`、`loop-actuator`、`loop-report`、`plan-reader`）以及 v0.3.4~v0.3.6 的 **Node Driver 层**（`loop-executor`、`executor-local`、`executor-claude`、`executor-glm`、`loop-server-core`）的接口契约与设计约束，统一记录在 [`docs/reports/agentic-loop-design.md`](../reports/agentic-loop-design.md)（核心循环 §1~§10、Node Driver + provider 解耦 §11）与 [`docs/plan/agentic-loop-node-driver(-m4m5).md`](../plan/agentic-loop-node-driver.md)。本文档不重复展开。

## 目录

- [概述](#概述)
- [分类标准](#分类标准)
- [Public API 参考](#public-api-参考)
  - [contracts/plugin-interface](#contractsplugin-interface)
  - [contracts/capabilities](#contractscapabilities)
  - [runtime/harness-build](#runtimeharness-build)
  - [runtime/plugin-loader](#runtimeplugin-loader)
  - [runtime/event-bus](#runtimeevent-bus)
  - [runtime/state-store](#runtimestate-store)
  - [runtime/logger](#runtimelogger)
  - [runtime/config-manager](#runtimeconfig-manager)
  - [runtime/manifest-resolver](#runtimemanifest-resolver)
  - [runtime/hook-dispatcher](#runtimehook-dispatcher)
  - [runtime/plugin-validator](#runtimeplugin-validator)
  - [runtime/validator-pipeline](#runtimevalidator-pipeline)
  - [runtime/audit-logger](#runtimeaudit-logger)
  - [runtime/yaml-parser](#runtimeyaml-parser)
  - [runtime/settings-merger](#runtimesettings-merger)
  - [runtime/claude-md-injector](#runtimeclaude-md-injector)
  - [runtime/resolve-plugin-path](#runtimeresolve-plugin-path)
  - [runtime/config-validator](#runtimeconfig-validator)
- [Experimental API 参考](#experimental-api-参考)
  - [runtime/sandbox-manager](#runtimesandbox-manager)
  - [runtime/sandbox-context](#runtimesandbox-context)
- [Internal API 索引](#internal-api-索引)
- [稳定性承诺](#稳定性承诺)

---

## 概述

Tackle Harness 的 API 分为三个稳定性等级：

| 等级 | 数量 | 描述 |
|------|------|------|
| **@public** | ~136 个 | 公共 API，破坏性变更遵循弃用策略 |
| **@internal** | ~64 个 | 内部 API，不保证跨版本兼容 |
| **@experimental** | ~11 个 | 实验性 API（沙箱相关），随时可能变更 |

## 分类标准

### @public -- 公共 API

- **定义**: 面向插件开发者和外部使用者的稳定接口
- **承诺**: 遵循语义化版本（SemVer），破坏性变更仅在主版本（major）中发生
- **变更策略**:
  1. 弃用（Deprecated）至少保留一个次版本（minor）
  2. 弃用期间在 JSDoc 中添加 `@deprecated` 标注
  3. 移除前在 CHANGELOG 中明确说明迁移路径
- **适用对象**: 插件开发者、CLI 用户、集成方

### @internal -- 内部 API

- **定义**: 模块内部使用的辅助方法，不属于公共契约
- **承诺**: 不保证跨版本兼容，可在任何版本中变更或移除
- **变更策略**:
  - 无提前通知要求
  - 无弃用周期
  - 变更不构成破坏性变更（breaking change）
- **适用对象**: Tackle Harness 核心开发者

### @experimental -- 实验性 API

- **定义**: 处于实验阶段的功能，接口设计尚未稳定
- **承诺**: 不保证任何兼容性，可能在次版本甚至补丁版本中变更
- **变更策略**:
  - 随时可能变更签名、语义或行为
  - 随时可能移除
  - 不提供迁移路径
- **适用对象**: 愿意承担兼容性风险的早期采用者

---

## Public API 参考

### contracts/plugin-interface

插件契约定义，包含所有插件类型的基类和生命周期常量。

#### `PluginState`

插件生命周期状态枚举。

```js
const { PluginState } = require('./contracts/plugin-interface');
// PluginState.DISCOVERED  = 'discovered'
// PluginState.LOADED      = 'loaded'
// PluginState.RESOLVED    = 'resolved'
// PluginState.ACTIVATED   = 'activated'
// PluginState.RUNNING     = 'running'
// PluginState.DEACTIVATED = 'deactivated'
// PluginState.UNLOADED    = 'unloaded'
```

| 值 | 说明 |
|---|------|
| `DISCOVERED` | 已发现，尚未加载 |
| `LOADED` | 已加载模块 |
| `RESOLVED` | 依赖已解析 |
| `ACTIVATED` | 已激活，可执行 |
| `RUNNING` | 正在执行 |
| `DEACTIVATED` | 已停用 |
| `UNLOADED` | 已卸载 |

#### `PluginType`

插件类型枚举。

```js
const { PluginType } = require('./contracts/plugin-interface');
// PluginType.SKILL     = 'skill'
// PluginType.HOOK      = 'hook'
// PluginType.VALIDATOR = 'validator'
// PluginType.PROVIDER  = 'provider'
```

#### `Plugin`

所有插件类型的基类。

**构造函数**: `new Plugin()`

| 属性 | 类型 | 说明 |
|------|------|------|
| `type` | `string` | 插件类型，子类必须设置 |
| `name` | `string` | 唯一 kebab-case 标识符 |
| `version` | `string` | semver 版本号 |
| `description` | `string` | 插件描述 |
| `dependencies` | `object` | 依赖声明 `{ plugins?: string[], providers?: string[] }` |
| `state` | `string` | 当前生命周期状态 |

**方法**:

##### `plugin.onActivate(context)`

插件激活时调用。

| 参数 | 类型 | 说明 |
|------|------|------|
| `context` | `PluginContext` | 注入的运行时上下文 |

**返回值**: `Promise<void>`

##### `plugin.onDeactivate()`

插件停用时调用。

**返回值**: `Promise<void>`

#### `SkillPlugin extends Plugin`

可执行技能插件。

| 额外属性 | 类型 | 说明 |
|------|------|------|
| `triggers` | `string[]` | 激活此技能的关键词 |
| `metadata` | `object` | 元数据（stage, requiresPlanMode, gatedByHuman, gatedByCode） |

##### `skill.execute(context, args)`

执行技能。

| 参数 | 类型 | 说明 |
|------|------|------|
| `context` | `PluginContext` | 运行时上下文 |
| `args` | `object` | 技能参数 |

**返回值**: `Promise<object>`

#### `HookPlugin extends Plugin`

生命周期钩子插件。

| 额外属性 | 类型 | 说明 |
|------|------|------|
| `trigger` | `object` | `{ event: string, tools?: string[], skills?: string[] }` |
| `priority` | `number` | 执行优先级，数值越小越先执行 |

##### `hook.handle(context)`

处理钩子调用。

| 参数 | 类型 | 说明 |
|------|------|------|
| `context` | `object` | 钩子上下文 |

**返回值**: `Promise<{ allowed: boolean, reason?: string, stateChanges?: object[] }>`

#### `ValidatorPlugin extends Plugin`

输出验证插件。

| 额外属性 | 类型 | 说明 |
|------|------|------|
| `targets` | `string[]` | 此验证器检查的技能名称 |
| `blocking` | `boolean` | 失败是否阻止工作流 |

##### `validator.validate(context)`

运行验证。

| 参数 | 类型 | 说明 |
|------|------|------|
| `context` | `object` | 验证上下文 |

**返回值**: `Promise<{ passed: boolean, errors: object[], warnings: object[] }>`

#### `ProviderPlugin extends Plugin`

能力提供者插件。

| 额外属性 | 类型 | 说明 |
|------|------|------|
| `provides` | `string` | 能力标识符 |

##### `provider.factory(context)`

创建提供者实例。

| 参数 | 类型 | 说明 |
|------|------|------|
| `context` | `PluginContext` | 运行时上下文 |

**返回值**: `Promise<object>`

#### `PluginContext`

注入到每个插件的运行时上下文。

**构造函数**: `new PluginContext(pluginName, runtime)`

| 参数 | 类型 | 说明 |
|------|------|------|
| `pluginName` | `string` | 插件名称 |
| `runtime` | `object` | `{ eventBus, stateStore, logger, configManager }` |

**属性**:

| 属性 | 类型 | 说明 |
|------|------|------|
| `pluginName` | `string` | 插件名称 |
| `eventBus` | `EventBus` | 事件总线 |
| `stateStore` | `StateStore` | 状态存储 |
| `logger` | `object` | 日志记录器 |
| `config` | `ConfigManager` | 配置管理器 |

**方法**:

##### `context.getProvider(name)`

按名称惰性获取 Provider 实例。

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | Provider 标识符 |

**返回值**: `Promise<object>`

##### `context.getPlugin(name)`

按名称获取已加载的插件实例。

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 插件名称 |

**返回值**: `Plugin | undefined`

---

### contracts/capabilities

能力声明和运行时强制执行模块。

#### `Capability`

能力枚举常量。

```js
const { Capability } = require('./contracts/capabilities');
// Capability.FS_READ       = 'fs.read'
// Capability.FS_WRITE      = 'fs.write'
// Capability.NET_REQUEST   = 'net.request'
// Capability.NET_LISTEN    = 'net.listen'
// Capability.CHILD_PROCESS = 'child_process'
// Capability.ENV_READ      = 'env.read'
// Capability.PLUGIN_ACCESS = 'plugin.access'
```

#### `CapabilityLevel`

能力风险等级。

```js
const { CapabilityLevel } = require('./contracts/capabilities');
// CapabilityLevel.SAFE      = 'safe'
// CapabilityLevel.LOW_RISK  = 'low_risk'
// CapabilityLevel.MEDIUM    = 'medium'
// CapabilityLevel.HIGH_RISK = 'high_risk'
```

#### `CAPABILITY_LEVELS`

能力到风险等级的映射（只读对象）。

```js
CAPABILITY_LEVELS['fs.read']       // 'low_risk'
CAPABILITY_LEVELS['fs.write']      // 'medium'
CAPABILITY_LEVELS['net.request']   // 'medium'
CAPABILITY_LEVELS['net.listen']    // 'high_risk'
CAPABILITY_LEVELS['child_process'] // 'high_risk'
CAPABILITY_LEVELS['env.read']      // 'low_risk'
CAPABILITY_LEVELS['plugin.access'] // 'low_risk'
```

#### `TRUST_LEVELS`

按来源类型（sourceType）的信任等级。

```js
TRUST_LEVELS.core  // 'full'
TRUST_LEVELS.npm   // 'moderate'
TRUST_LEVELS.local // 'low'
```

#### `isCapabilityAllowed(sourceType, capability, declaredCapabilities)`

检查特定能力是否被允许。

| 参数 | 类型 | 说明 |
|------|------|------|
| `sourceType` | `string` | `'core'` / `'npm'` / `'local'` |
| `capability` | `string` | Capability 枚举值 |
| `declaredCapabilities` | `object` | 可选，plugin.json 中的 capabilities 字段 |

**返回值**: `{ allowed: boolean, reason: string }`

```js
var result = isCapabilityAllowed('npm', 'fs.read', { filesystem: true });
// { allowed: true, reason: 'fs.read declared in plugin.json' }
```

#### `shouldSandbox(sourceType)`

判断插件是否应在沙箱中运行。核心插件在主进程运行，npm/local 插件在 Worker Thread 中沙箱化运行。

| 参数 | 类型 | 说明 |
|------|------|------|
| `sourceType` | `string` | `'core'` / `'npm'` / `'local'` |

**返回值**: `boolean`

#### `getAllowedCapabilities(sourceType, declaredCapabilities)`

获取指定 sourceType 下所有被允许的能力列表。

| 参数 | 类型 | 说明 |
|------|------|------|
| `sourceType` | `string` | 来源类型 |
| `declaredCapabilities` | `object` | 可选，已声明的能力 |

**返回值**: `string[]`

---

### runtime/harness-build

插件构建器，将插件注册表转换为 Claude Code 原生格式。

#### `new HarnessBuild(options)`

| 参数 | 类型 | 说明 |
|------|------|------|
| `options.rootDir` | `string` | 项目根目录（已弃用，使用 targetRoot） |
| `options.targetRoot` | `string` | 目标项目根目录 |
| `options.packageRoot` | `string` | tackle-harness 包根目录 |
| `options.registryPath` | `string` | plugin-registry.json 路径覆盖 |
| `options.pluginsDir` | `string` | plugins/core/ 路径覆盖 |
| `options.outputSkillsDir` | `string` | 输出 .claude/skills/ 路径覆盖 |
| `options.outputHooksDir` | `string` | 输出 .claude/hooks/ 路径覆盖 |
| `options.verbose` | `boolean` | 启用详细日志 |
| `options.globalMode` | `boolean` | 全局安装模式 |
| `options.cliPath` | `string` | CLI 二进制文件绝对路径 |

##### `builder.validate()`

验证注册表中所有插件的 plugin.json 格式。

**返回值**: `{ valid: boolean, errors: object[], warnings: object[], summary: string }`

##### `builder.build()`

构建所有插件到 Claude Code 原生格式。

**返回值**: `{ success: boolean, built: object[], errors: object[], summary: string }`

##### `builder.validateConfig()`

验证 harness-config.yaml 配置文件。

**返回值**: `{ valid: boolean, errors: string[], warnings: string[], summary: string }`

##### `builder.updateSettings(targetRoot, packageRoot)`

合并 tackle-harness hooks 到目标项目的 .claude/settings.json。

| 参数 | 类型 | 说明 |
|------|------|------|
| `targetRoot` | `string` | 目标项目根目录 |
| `packageRoot` | `string` | 本包根目录 |

##### `builder.injectClaudeMdRules(targetRoot)`

注入 tackle-harness 管理的规则到目标项目的 CLAUDE.md。

| 参数 | 类型 | 说明 |
|------|------|------|
| `targetRoot` | `string` | 目标项目根目录 |

#### `HarnessBuild.run(argv)`

CLI 入口点（静态方法）。

| 参数 | 类型 | 说明 |
|------|------|------|
| `argv` | `string[]` | `process.argv` |

---

### runtime/plugin-loader

插件发现、依赖解析和生命周期管理。

#### `new PluginLoader(options)`

| 参数 | 类型 | 说明 |
|------|------|------|
| `options.registryPath` | `string` | plugin-registry.json 路径 |
| `options.eventBus` | `EventBus` | EventBus 实例 |
| `options.stateStore` | `StateStore` | StateStore 实例 |
| `options.configManager` | `ConfigManager` | ConfigManager 实例 |
| `options.logger` | `Logger` | Logger 实例 |

##### `loader.loadAll()`

加载并激活注册表中所有插件，按拓扑排序的依赖顺序执行。

**返回值**: `Promise<string[]>` -- 成功加载的插件名称列表

```js
const loader = new PluginLoader({ registryPath, eventBus, stateStore, configManager, logger });
const loaded = await loader.loadAll();
// ['skill-task-creator', 'hook-skill-gate', ...]
```

##### `loader.activate(name)`

激活单个已加载的插件。创建 PluginContext 并注入服务。

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 插件名称 |

**返回值**: `Promise<void>`

##### `loader.deactivate(name)`

停用单个插件。

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 插件名称 |

**返回值**: `Promise<void>`

##### `loader.deactivateAll()`

按逆序停用所有已加载的插件。

**返回值**: `Promise<void>`

##### `loader.getPlugin(name)`

按名称获取已加载的插件。

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 插件名称 |

**返回值**: `object | undefined`

##### `loader.isLoaded(name)`

检查插件是否已加载。

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 插件名称 |

**返回值**: `boolean`

##### `loader.getLoadedNames()`

获取所有已加载插件的名称列表。

**返回值**: `string[]`

##### `loader.getProvider(name)`

按名称获取已注册的 Provider 实例。

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | Provider 名称 |

**返回值**: `object | undefined`

##### `loader.getRegisteredProviders()`

获取所有已注册的 Provider 名称。

**返回值**: `string[]`

##### `loader.getHookDispatcher()`

获取 HookDispatcher 实例。返回 `null` 如果还没有 Hook 插件被激活。

**返回值**: `HookDispatcher | null`

##### `loader.getValidatorPipeline()`

获取 ValidatorPipeline 实例。返回 `null` 如果还没有 Validator 插件被激活。

**返回值**: `ValidatorPipeline | null`

##### `loader.dispatchHook(context)`

使用内部模式分派钩子事件。

| 参数 | 类型 | 说明 |
|------|------|------|
| `context` | `object` | `{ event, tool?, skill? }` |

**返回值**: `Promise<{ allowed: boolean, results?, reason? }>`

---

### runtime/event-bus

事件分发系统。

#### `new EventBus(options)`

| 参数 | 类型 | 说明 |
|------|------|------|
| `options.maxHistory` | `number` | 最大事件历史条目数，默认 100 |

##### `bus.on(event, handler)`

注册事件处理器。

| 参数 | 类型 | 说明 |
|------|------|------|
| `event` | `string` | 事件名称 |
| `handler` | `Function` | 回调函数 `callback(eventData)` |

**返回值**: `{ unsubscribe: Function }` -- 订阅句柄

```js
var sub = bus.on('plugin:loaded', function(data) {
  console.log('Plugin loaded:', data.pluginName);
});
// 取消订阅
sub.unsubscribe();
```

##### `bus.once(event, handler)`

注册一次性事件处理器，首次触发后自动移除。

| 参数 | 类型 | 说明 |
|------|------|------|
| `event` | `string` | 事件名称 |
| `handler` | `Function` | 回调函数 |

**返回值**: `{ unsubscribe: Function }`

##### `bus.off(event, handler)`

移除特定事件处理器。

| 参数 | 类型 | 说明 |
|------|------|------|
| `event` | `string` | 事件名称 |
| `handler` | `Function` | 原始传入的函数引用 |

##### `bus.emit(event, data)`

同步分发事件，调用所有已注册的处理器。单个处理器的错误不会传播。

| 参数 | 类型 | 说明 |
|------|------|------|
| `event` | `string` | 事件名称 |
| `data` | `*` | 事件数据 |

##### `bus.getHistory(filter)`

查询事件历史记录用于调试。

| 参数 | 类型 | 说明 |
|------|------|------|
| `filter.event` | `string` | 事件名称子串匹配 |
| `filter.since` | `number` | 时间戳下限（ms） |
| `filter.until` | `number` | 时间戳上限（ms） |
| `filter.limit` | `number` | 最大返回条目数 |

**返回值**: `object[]`

##### `bus.clearHistory()`

清除所有事件历史记录。

##### `bus.removeAllListeners(event)`

移除特定事件或所有事件的处理器。

| 参数 | 类型 | 说明 |
|------|------|------|
| `event` | `string` | 可选，不传则清除所有 |

##### `bus.listenerCount(event)`

获取指定事件的处理器数量。

| 参数 | 类型 | 说明 |
|------|------|------|
| `event` | `string` | 事件名称 |

**返回值**: `number`

---

### runtime/state-store

基于文件的支持点记法的键值状态存储。

#### `new StateStore(options)`

| 参数 | 类型 | 说明 |
|------|------|------|
| `options.filePath` | `string` | 状态文件路径，默认 `.claude-state` |
| `options.adapter` | `object` | 自定义适配器（测试用），覆盖 filePath |

##### `store.get(key)`

按键获取值。

| 参数 | 类型 | 说明 |
|------|------|------|
| `key` | `string` | 点记法键，如 `'harness.state'` |

**返回值**: `Promise<* | undefined>`

##### `store.set(key, value)`

设置键值。

| 参数 | 类型 | 说明 |
|------|------|------|
| `key` | `string` | 点记法键 |
| `value` | `*` | 任意值 |

**返回值**: `Promise<void>`

##### `store.delete(key)`

删除键。

| 参数 | 类型 | 说明 |
|------|------|------|
| `key` | `string` | 点记法键 |

**返回值**: `Promise<void>`

##### `store.subscribe(key, callback)`

订阅键变更通知。

| 参数 | 类型 | 说明 |
|------|------|------|
| `key` | `string` | 监听的键 |
| `callback` | `Function` | `callback(key, oldValue, newValue)` |

**返回值**: `{ unsubscribe: Function }`

##### `store.keys()`

获取所有已存储的键列表。

**返回值**: `Promise<string[]>`

##### `store.invalidate()`

强制下次访问时从磁盘重新加载。

#### `MemoryAdapter`

内存适配器，用于测试环境。

```js
const { MemoryAdapter } = require('./state-store');
var adapter = new MemoryAdapter();
adapter.write({ foo: 'bar' });
adapter.read(); // { foo: 'bar' }
```

---

### runtime/logger

插件级日志服务。

#### `new Logger(options)`

| 参数 | 类型 | 说明 |
|------|------|------|
| `options.level` | `string` | 最低日志级别，默认 `'info'` |
| `options.maxHistory` | `number` | 最大历史条目数，默认 500 |

##### `logger.debug(plugin, message, data)`

记录调试消息。

| 参数 | 类型 | 说明 |
|------|------|------|
| `plugin` | `string` | 插件名称 |
| `message` | `string` | 日志消息 |
| `data` | `object` | 可选，附加数据 |

##### `logger.info(plugin, message, data)`

记录信息消息。

##### `logger.warn(plugin, message, data)`

记录警告消息。

##### `logger.error(plugin, message, data)`

记录错误消息。

##### `logger.query(filter)`

查询日志历史。

| 参数 | 类型 | 说明 |
|------|------|------|
| `filter.plugin` | `string` | 按插件名称过滤 |
| `filter.level` | `string` | 按级别过滤 |
| `filter.since` | `number` | 时间戳下限（ms） |
| `filter.until` | `number` | 时间戳上限（ms） |
| `filter.limit` | `number` | 最大返回条目数 |

**返回值**: `object[]`

##### `logger.clear()`

清除所有历史条目。

##### `logger.createChild(pluginName)`

创建绑定到特定插件的子日志记录器。子日志器暴露 `debug/info/warn/error` 方法，无需传入 plugin 参数。

| 参数 | 类型 | 说明 |
|------|------|------|
| `pluginName` | `string` | 插件名称 |

**返回值**: `{ debug, info, warn, error }` -- 子日志器

```js
var childLog = logger.createChild('my-plugin');
childLog.info('Hello'); // 等同于 logger.info('my-plugin', 'Hello')
```

---

### runtime/config-manager

三层配置管理：环境变量 > harness-config.yaml > 插件默认值。

#### `new ConfigManager(options)`

| 参数 | 类型 | 说明 |
|------|------|------|
| `options.configPath` | `string` | harness-config.yaml 路径 |
| `options.defaults` | `object` | 插件默认配置 `{ pluginName: { key: value } }` |

##### `manager.get(key, defaultValue)`

按三层优先级获取配置值。

| 参数 | 类型 | 说明 |
|------|------|------|
| `key` | `string` | 点记法键 |
| `defaultValue` | `*` | 所有层级均未找到时的回退值 |

**返回值**: `*`

```js
manager.get('context_window.chunk_size');  // 120000
manager.get('nonexistent', 'fallback');     // 'fallback'
```

##### `manager.getForPlugin(pluginName, key, defaultValue)`

获取特定插件的配置值，按插件级别优先级解析。

| 参数 | 类型 | 说明 |
|------|------|------|
| `pluginName` | `string` | 插件名称 |
| `key` | `string` | 配置键 |
| `defaultValue` | `*` | 默认值 |

**返回值**: `*`

##### `manager.setOverride(key, value)`

设置运行时覆盖，最高优先级。

| 参数 | 类型 | 说明 |
|------|------|------|
| `key` | `string` | 点记法键 |
| `value` | `*` | 覆盖值 |

##### `manager.clearOverride(key)`

清除运行时覆盖。

| 参数 | 类型 | 说明 |
|------|------|------|
| `key` | `string` | 点记法键 |

##### `manager.getAll()`

获取完整的已解析 YAML 配置对象。

**返回值**: `object`

##### `manager.forPlugin(pluginName)`

创建特定插件的配置范围 getter。

| 参数 | 类型 | 说明 |
|------|------|------|
| `pluginName` | `string` | 插件名称 |

**返回值**: `{ get: Function }`

```js
var config = manager.forPlugin('agent-dispatcher');
config.get('max_agents'); // 插件级别的配置值
```

---

### runtime/manifest-resolver

项目级插件选择系统，管理全局注册表与项目 manifest 的合并。

#### `readGlobalRegistry(packageRoot)`

读取全局插件注册表。

| 参数 | 类型 | 说明 |
|------|------|------|
| `packageRoot` | `string` | tackle-harness 包根目录 |

**返回值**: `object` -- 解析后的注册表对象

#### `readProjectManifest(targetRoot)`

读取项目 manifest 文件。

| 参数 | 类型 | 说明 |
|------|------|------|
| `targetRoot` | `string` | 目标项目根目录 |

**返回值**: `object | null`

#### `resolveEffectivePlugins(packageRoot, targetRoot)`

合并全局注册表与项目 manifest，解析有效的插件列表。

| 参数 | 类型 | 说明 |
|------|------|------|
| `packageRoot` | `string` | 包根目录 |
| `targetRoot` | `string` | 目标项目根目录 |

**返回值**: `object` -- 合并后的注册表对象

#### `writeProjectManifest(targetRoot, manifest)`

写入项目 manifest 文件。

| 参数 | 类型 | 说明 |
|------|------|------|
| `targetRoot` | `string` | 目标项目根目录 |
| `manifest` | `object` | Manifest 对象 |

**返回值**: `boolean` -- 是否成功

#### `createDefaultManifest(packageRoot)`

从全局注册表创建默认 manifest。

| 参数 | 类型 | 说明 |
|------|------|------|
| `packageRoot` | `string` | 包根目录 |

**返回值**: `object` -- 默认 manifest

#### `updatePluginInManifest(packageRoot, targetRoot, pluginName, enabled)`

更新项目 manifest 中单个插件的启用状态。

| 参数 | 类型 | 说明 |
|------|------|------|
| `packageRoot` | `string` | 包根目录 |
| `targetRoot` | `string` | 目标项目根目录 |
| `pluginName` | `string` | 插件名称 |
| `enabled` | `boolean` | 新的启用状态 |

**返回值**: `boolean`

#### `registerExternalPlugin(packageRoot, targetRoot, pluginName, options)`

在项目 manifest 中注册外部插件。用于 `tackle install` 命令。

| 参数 | 类型 | 说明 |
|------|------|------|
| `packageRoot` | `string` | 包根目录 |
| `targetRoot` | `string` | 目标项目根目录 |
| `pluginName` | `string` | 外部插件名称 |
| `options.sourceType` | `string` | 来源类型 `'npm'` / `'local'` |
| `options.source` | `string` | 来源标识符 |
| `options.enabled` | `boolean` | 初始启用状态 |
| `options.config` | `object` | 插件配置 |

**返回值**: `boolean`

#### `unregisterExternalPlugin(packageRoot, targetRoot, pluginName)`

从项目 manifest 中移除外部插件（核心插件只能禁用不能移除）。

| 参数 | 类型 | 说明 |
|------|------|------|
| `packageRoot` | `string` | 包根目录 |
| `targetRoot` | `string` | 目标项目根目录 |
| `pluginName` | `string` | 插件名称 |

**返回值**: `boolean`

#### `listExternalPlugins(packageRoot, targetRoot)`

列出项目 manifest 中所有外部插件。

| 参数 | 类型 | 说明 |
|------|------|------|
| `packageRoot` | `string` | 包根目录 |
| `targetRoot` | `string` | 目标项目根目录 |

**返回值**: `object[]` -- 外部插件条目数组

---

### runtime/hook-dispatcher

双模式钩子执行分发器。

#### `ExecutionMode`

执行模式常量。

```js
const { ExecutionMode } = require('./hook-dispatcher');
// ExecutionMode.EXTERNAL = 'external'  // 基于 settings.json 命令
// ExecutionMode.INTERNAL = 'internal'  // 编程式调用 HookPlugin.handle()
```

#### `new HookDispatcher(options)`

| 参数 | 类型 | 说明 |
|------|------|------|
| `options.pluginLoader` | `PluginLoader` | PluginLoader 实例（内部模式必需） |
| `options.logger` | `Logger` | Logger 实例 |
| `options.mode` | `string` | 默认执行模式 |

##### `dispatcher.dispatch(context)`

分发钩子事件。

| 参数 | 类型 | 说明 |
|------|------|------|
| `context.event` | `string` | 事件类型：`'PreToolUse'` / `'PostToolUse'` / `'SessionStart'` |
| `context.tool` | `string` | 工具名称（PreToolUse/PostToolUse） |
| `context.skill` | `string` | 技能名称（PostToolUse） |
| `context.mode` | `string` | 覆盖本次执行的执行模式 |

**返回值**: `Promise<{ allowed: boolean, results?: object[], reason?: string }>`

##### `dispatcher.setMode(mode)`

设置默认执行模式。

| 参数 | 类型 | 说明 |
|------|------|------|
| `mode` | `string` | `'external'` 或 `'internal'` |

##### `dispatcher.getMode()`

获取当前默认执行模式。

**返回值**: `string`

##### `dispatcher.canUseInternalMode()`

检查内部模式是否可用（需要 pluginLoader）。

**返回值**: `boolean`

##### `dispatcher.getHookStats()`

获取已加载钩子的统计信息。

**返回值**: `{ total: number, byEvent: object, byPriority: object[] }`

---

### runtime/plugin-validator

插件格式验证模块。

#### `PLUGIN_REQUIRED_FIELDS`

plugin.json 必需字段列表。

```js
// ['name', 'version', 'type', 'description']
```

#### `VALID_PLUGIN_TYPES`

有效插件类型列表。

```js
// ['skill', 'hook', 'validator', 'provider']
```

#### `validatePlugin(entry, pluginDir)`

验证单个插件条目。检查目录存在性、plugin.json 格式、必需字段、类型有效性和伴随文件。

| 参数 | 类型 | 说明 |
|------|------|------|
| `entry` | `object` | 注册表条目 |
| `pluginDir` | `string` | 插件目录路径 |

**返回值**: `{ errors: object[], warnings: object[] }`

#### `formatValidationSummary(options)`

格式化验证结果为可读的摘要字符串。

| 参数 | 类型 | 说明 |
|------|------|------|
| `options.totalPlugins` | `number` | 检查的插件总数 |
| `options.errors` | `object[]` | 验证错误 |
| `options.warnings` | `object[]` | 验证警告 |

**返回值**: `string`

#### `validateCapabilities(capabilities)`

验证 plugin.json 中的 capabilities 字段。

| 参数 | 类型 | 说明 |
|------|------|------|
| `capabilities` | `object` | plugin.json 的 capabilities 字段 |

**返回值**: `object[]` -- 警告对象数组 `{ field, message }`

#### `getKnownCapabilities()`

获取已知能力名称列表。

**返回值**: `string[]`

#### `validateWithSchema(pluginJson)`

使用 JSON Schema 正式验证 plugin.json 对象。优先使用 ajv（可选依赖），否则回退到内联验证。

| 参数 | 类型 | 说明 |
|------|------|------|
| `pluginJson` | `object` | 解析后的 plugin.json 对象 |

**返回值**: `{ valid: boolean, errors: object[] }`

---

### runtime/validator-pipeline

验证器执行管线。

#### `ExecutionMode`

验证器执行模式。

```js
// ExecutionMode.BLOCKING     = 'blocking'      // 验证失败时中断工作流
// ExecutionMode.NON_BLOCKING  = 'non-blocking'  // 仅记录警告，继续执行
```

#### `WorkflowPhase`

工作流阶段常量。

```js
// WorkflowPhase.BUILD     = 'build'
// WorkflowPhase.WP_CREATE = 'wp-create'
// WorkflowPhase.WP_MODIFY = 'wp-modify'
// WorkflowPhase.MANUAL    = 'manual'
```

#### `new ValidatorPipeline(options)`

| 参数 | 类型 | 说明 |
|------|------|------|
| `options.pluginLoader` | `PluginLoader` | PluginLoader 实例（必需） |
| `options.eventBus` | `EventBus` | EventBus 实例 |
| `options.logger` | `Logger` | Logger 实例 |
| `options.projectRoot` | `string` | 项目根目录 |

##### `pipeline.runValidator(validatorName, options)`

运行单个验证器。

| 参数 | 类型 | 说明 |
|------|------|------|
| `validatorName` | `string` | 验证器插件名称 |
| `options.mode` | `string` | 执行模式 |
| `options.context` | `object` | 传递给验证器的上下文 |

**返回值**: `Promise<{ passed: boolean, errors: object[], warnings: object[], mode: string }>`

##### `pipeline.runAllValidators(options)`

运行指定工作流阶段的所有验证器。

| 参数 | 类型 | 说明 |
|------|------|------|
| `options.phase` | `string` | 工作流阶段 |
| `options.mode` | `string` | 默认执行模式 |
| `options.stopOnFirstError` | `boolean` | 是否在首个错误时停止 |

**返回值**: `Promise<{ results: object[], overallPassed: boolean, totalErrors: number, totalWarnings: number }>`

##### `pipeline.runPostBuildValidators(options)`

运行构建后验证器（便捷方法）。

**返回值**: `Promise<object>`

##### `pipeline.runWPValidators(wpId, operation, options)`

运行工作包相关验证器。

| 参数 | 类型 | 说明 |
|------|------|------|
| `wpId` | `string` | 工作包 ID（如 `'WP-001'`） |
| `operation` | `string` | `'create'` 或 `'modify'` |
| `options` | `object` | 额外选项 |

**返回值**: `Promise<object>`

##### `pipeline.getCachedResult(validatorName)`

获取缓存的验证器结果。

**返回值**: `object | undefined`

##### `pipeline.clearCache()`

清除所有缓存的验证器结果。

---

### runtime/audit-logger

JSONL 审计日志持久化模块。

#### `new AuditLogger(options)`

| 参数 | 类型 | 说明 |
|------|------|------|
| `options.logDir` | `string` | 审计日志目录，默认 `.claude/logs` |
| `options.sessionId` | `string` | 会话标识符 |
| `options.logger` | `Logger` | Logger 实例 |
| `options.flushInterval` | `number` | 刷盘间隔（ms），默认 1000 |
| `options.maxBufferSize` | `number` | 最大缓冲条目数，默认 100 |

##### `auditLogger.log(event, plugin, details)`

记录审计事件。事件被缓冲并定期或缓冲区满时刷盘。

| 参数 | 类型 | 说明 |
|------|------|------|
| `event` | `string` | 事件类型（`sandbox.create`、`capability.check` 等） |
| `plugin` | `string` | 插件名称 |
| `details` | `object` | 附加字段（`sourceType`, `capability`, `decision`, `detail`） |

##### `auditLogger.logCapabilityCheck(plugin, capability, decision, detail, sourceType)`

记录能力检查事件的快捷方法。

| 参数 | 类型 | 说明 |
|------|------|------|
| `plugin` | `string` | 插件名称 |
| `capability` | `string` | 请求的能力 |
| `decision` | `string` | `'allow'` / `'deny'` / `'warn'` / `'error'` |
| `detail` | `string` | 详细信息 |
| `sourceType` | `string` | 插件来源类型 |

##### `auditLogger.logSandboxEvent(event, plugin, detail)`

记录沙箱生命周期事件的快捷方法。

| 参数 | 类型 | 说明 |
|------|------|------|
| `event` | `string` | `'sandbox.create'` / `'sandbox.terminate'` |
| `plugin` | `string` | 插件名称 |
| `detail` | `string` | 详细信息 |

##### `auditLogger.logPluginLoad(plugin, sourceType, decision, detail)`

记录插件加载事件的快捷方法。

| 参数 | 类型 | 说明 |
|------|------|------|
| `plugin` | `string` | 插件名称 |
| `sourceType` | `string` | 来源类型 |
| `decision` | `string` | `'allow'` / `'deny'` |
| `detail` | `string` | 能力审查摘要 |

##### `auditLogger.flush()`

强制将所有缓冲条目刷盘到磁盘。

##### `auditLogger.destroy()`

销毁审计日志器，刷盘剩余条目。调用后无法再记录事件。

##### `auditLogger.query(filter)`

查询当日日志文件中的审计条目。

| 参数 | 类型 | 说明 |
|------|------|------|
| `filter.event` | `string` | 按事件类型过滤 |
| `filter.plugin` | `string` | 按插件名称过滤 |
| `filter.decision` | `string` | 按决策过滤 |
| `filter.limit` | `number` | 最大返回条目数 |

**返回值**: `AuditEntry[]`

##### `auditLogger.getLogFilePath(date)`

获取指定日期的日志文件路径。

| 参数 | 类型 | 说明 |
|------|------|------|
| `date` | `Date` | 日期对象，默认今天 |

**返回值**: `string` -- JSONL 文件的绝对路径

---

### runtime/yaml-parser

手写 YAML 解析器，支持 harness-config.yaml 所需的有限 YAML 子集。

#### `parseYamlFile(filePath)`

解析 YAML 文件为 JavaScript 对象。

| 参数 | 类型 | 说明 |
|------|------|------|
| `filePath` | `string` | YAML 文件的绝对路径 |

**返回值**: `object` -- 解析后的配置对象，出错时返回空对象

#### `parseYamlString(content)`

解析 YAML 字符串为 JavaScript 对象。

| 参数 | 类型 | 说明 |
|------|------|------|
| `content` | `string` | YAML 字符串 |

**返回值**: `object`

#### `parseValue(val)`

解析 YAML 标量值。

| 参数 | 类型 | 说明 |
|------|------|------|
| `val` | `string` | 原始字符串值 |

**返回值**: `boolean | null | number | string`

#### `serializeConfigValue(val)`

序列化配置值用于注入 skill.md 注释块。

| 参数 | 类型 | 说明 |
|------|------|------|
| `val` | `*` | 要序列化的值 |

**返回值**: `string`

---

### runtime/settings-merger

合并 tackle-harness hooks 到项目 settings.json。

#### `mergeSettings(options)`

合并 tackle-harness hooks 到目标项目的 .claude/settings.json。幂等操作。

| 参数 | 类型 | 说明 |
|------|------|------|
| `options.targetRoot` | `string` | 目标项目根目录 |
| `options.packageRoot` | `string` | 本包根目录 |
| `options.ensureDir` | `Function` | 可选，目录创建函数（可注入用于测试） |

#### `isLocalInstall(packageRoot, targetRoot)`

检测是否为本地安装。

| 参数 | 类型 | 说明 |
|------|------|------|
| `packageRoot` | `string` | 包根目录 |
| `targetRoot` | `string` | 目标项目根目录 |

**返回值**: `boolean`

#### `upsertHookEntry(hookArray, matcher, command)`

更新或插入 hook 条目。若匹配器已存在则更新命令，否则添加新条目。

| 参数 | 类型 | 说明 |
|------|------|------|
| `hookArray` | `object[]` | hooks 数组 |
| `matcher` | `string` | 匹配器字符串 |
| `command` | `string` | 完整命令字符串 |

---

### runtime/claude-md-injector

注入 tackle-harness 管理规则到 CLAUDE.md。

#### `buildRuleBlock(pluginEntries, resolvePluginDir)`

构建 CLAUDE.md 注入的规则块内容。

| 参数 | 类型 | 说明 |
|------|------|------|
| `pluginEntries` | `object[]` | 启用的插件条目 |
| `resolvePluginDir` | `Function` | 插件目录解析函数 |

**返回值**: `string` -- 规则块内容，无 plan_mode_required 技能时返回空字符串

#### `injectClaudeMdRules(options)`

注入 tackle-harness 管理规则到目标项目的 CLAUDE.md。幂等操作。

| 参数 | 类型 | 说明 |
|------|------|------|
| `options.targetRoot` | `string` | 目标项目根目录 |
| `options.pluginEntries` | `object[]` | 启用的插件条目 |
| `options.resolvePluginDir` | `Function` | 插件目录解析函数 |
| `options.log` | `Function` | 可选日志函数 |

---

### runtime/resolve-plugin-path

共享的插件路径解析模块。

#### `resolvePluginPath(entry, defaultPluginsDir, registryDir)`

解析插件条目的文件系统目录路径。

| 参数 | 类型 | 说明 |
|------|------|------|
| `entry.name` | `string` | 插件名称 |
| `entry.source` | `string` | 可选，来源标识符 |
| `entry.sourceType` | `string` | 可选，来源类型 `'core'`/`'npm'`/`'local'` |
| `defaultPluginsDir` | `string` | 核心插件基础目录 |
| `registryDir` | `string` | 注册表文件所在目录 |

**返回值**: `string` -- 解析后的插件目录绝对路径

**抛出**: `Error` -- sourceType 无效或 npm 包无法解析

#### `VALID_SOURCE_TYPES`

有效来源类型列表。

```js
// ['core', 'npm', 'local']
```

---

### runtime/config-validator

基于 Schema 的配置验证器。

#### `new ConfigValidator(options)`

| 参数 | 类型 | 说明 |
|------|------|------|
| `options.schema` | `object` | 自定义 schema |

##### `validator.validateFile(configPath)`

验证配置文件。

| 参数 | 类型 | 说明 |
|------|------|------|
| `configPath` | `string` | harness-config.yaml 路径 |

**返回值**: `{ valid: boolean, errors: string[], warnings: string[] }`

##### `validator.validate(config)`

验证配置对象。

| 参数 | 类型 | 说明 |
|------|------|------|
| `config` | `object` | 解析后的配置对象 |

**返回值**: `{ valid: boolean, errors: string[], warnings: string[] }`

##### `validator.getDefaults()`

获取默认配置对象。

**返回值**: `object`

---

## Experimental API 参考

> **警告**: 以下 API 处于实验阶段，可能在任何版本中变更或移除，不提供迁移路径。

### runtime/sandbox-manager

Worker Thread 生命周期管理，用于插件沙箱化执行。

> **不稳定警告**: 此模块的 API 设计尚未稳定。构造函数签名、方法参数和返回值格式可能在未来版本中变更。

#### `new SandboxManager(options)`

| 参数 | 类型 | 说明 |
|------|------|------|
| `options.auditLogger` | `AuditLogger` | 可选，审计日志实例 |
| `options.logDir` | `string` | 审计日志目录 |
| `options.logger` | `Logger` | Logger 实例 |
| `options.sandboxScriptPath` | `string` | sandbox worker 脚本路径 |

##### `manager.requiresSandbox(sourceType)`

检查插件是否需要沙箱运行。

| 参数 | 类型 | 说明 |
|------|------|------|
| `sourceType` | `string` | `'core'` / `'npm'` / `'local'` |

**返回值**: `boolean`

##### `manager.createSandboxedWorker(options)`

为插件创建沙箱 Worker Thread 并激活。

| 参数 | 类型 | 说明 |
|------|------|------|
| `options.pluginName` | `string` | 插件名称 |
| `options.pluginPath` | `string` | 插件目录绝对路径 |
| `options.sourceType` | `string` | `'npm'` / `'local'` |
| `options.declaredCapabilities` | `object` | plugin.json 中的 capabilities |
| `options.mainThreadServices` | `object` | `{ eventBus, stateStore, logger, configManager, getProvider }` |
| `options.timeout` | `number` | 激活超时（ms），默认 30000 |

**返回值**: `Promise<void>`

##### `manager.terminateWorker(pluginName, reason)`

终止沙箱 Worker。

| 参数 | 类型 | 说明 |
|------|------|------|
| `pluginName` | `string` | 插件名称 |
| `reason` | `string` | 可选，终止原因 |

**返回值**: `Promise<void>`

##### `manager.terminateAll()`

终止所有活跃的沙箱 Worker。

**返回值**: `Promise<void>`

##### `manager.hasWorker(pluginName)`

检查插件是否有活跃的沙箱。

**返回值**: `boolean`

##### `manager.getWorkerInfo(pluginName)`

获取沙箱化插件的信息。

**返回值**: `{ threadId: number, sourceType: string, active: boolean } | null`

##### `manager.getAuditLogger()`

获取 AuditLogger 实例。

**返回值**: `AuditLogger`

##### `manager.destroy()`

销毁 SandboxManager，终止所有 Worker 并刷盘审计日志。

### runtime/sandbox-context

独立的 RPC 代理上下文工厂，用于沙箱化插件执行。

> **不稳定警告**: 此模块为沙箱功能的内部组件，接口可能随沙箱设计变更而变更。

#### `createSandboxProxy(pluginName, port)`

创建模拟 PluginContext 接口的沙箱代理对象。所有方法调用通过消息端口转发为 RPC 消息。

| 参数 | 类型 | 说明 |
|------|------|------|
| `pluginName` | `string` | 插件名称 |
| `port` | `object` | 具有 `postMessage`/`on`/`off` 方法的消息端口 |

**返回值**: `object` -- 代理上下文对象

#### `createMainThreadBridge(services, options)`

创建主线程 RPC 处理器，将调用分发到真实服务。

| 参数 | 类型 | 说明 |
|------|------|------|
| `services` | `object` | `{ eventBus, stateStore, logger, configManager, getProvider }` |
| `options.onRpc` | `Function` | 可选，每个 RPC 调用的回调 |

**返回值**: `Function` -- 消息处理函数

---

## Internal API 索引

以下为模块内部使用的 API，不保证跨版本兼容。仅列出模块名和方法名列表，不提供详细文档。

### contracts/capabilities

| 方法/属性 | 说明 |
|------|------|
| `CAPABILITY_RESTRICTIONS` | 按来源类型的能力限制矩阵 |
| `_capabilityToTopLevelKey(capability)` | 将 Capability 枚举值映射回 plugin.json 顶层键 |

### runtime/harness-build

| 方法 | 说明 |
|------|------|
| `_readRegistry()` | 读取并解析插件注册表 |
| `_getPluginEntries(registry)` | 从注册表提取插件条目 |
| `_validatePlugin(entry)` | 验证单个插件条目 |
| `_resolvePluginDir(entry)` | 解析插件目录路径 |
| `_buildPlugin(entry)` | 构建单个插件 |
| `_buildSkillPlugin(name, pluginDir, meta)` | 构建技能插件 |
| `_buildHookPlugin(name, pluginDir, meta)` | 构建钩子插件 |
| `_buildValidatorPlugin(name, pluginDir, meta)` | 构建验证器插件 |
| `_buildProviderPlugin(name, pluginDir, meta)` | 构建提供者插件 |
| `_formatBuildSummary(results, errors)` | 格式化构建摘要 |
| `_hasFrontMatter(content)` | 检查 skill.md 是否有前置信息 |
| `_generateSkillFrontMatter(meta)` | 生成技能前置信息 |
| `_generateSkillContent(meta)` | 生成技能内容 |
| `_generateHookStub(meta)` | 生成钩子存根 |
| `_readHarnessConfig()` | 读取并缓存 harness 配置 |
| `_injectContextConfig(content, pluginName)` | 注入上下文窗口配置 |
| `_ensureDir(dirPath)` | 确保目录存在 |
| `_mkdirRecursive(dirPath)` | 递归创建目录 |
| `_copyDirectory(srcDir, destDir)` | 递归复制目录 |
| `_log(level, message)` | 内部日志 |
| `_isLocalInstall(packageRoot, targetRoot)` | 检测安装模式 |

### runtime/plugin-loader

| 方法 | 说明 |
|------|------|
| `_readRegistry()` | 读取注册表文件 |
| `_getPluginNames()` | 提取插件名称和配置 |
| `_buildDependencyGraph(pluginNames)` | 构建依赖图 |
| `_buildProviderMap(pluginNames)` | 构建 provider 名称映射 |
| `_topologicalSort(graph)` | 拓扑排序 |
| `_loadPlugin(name, config)` | 加载单个插件 |
| `_readPluginJson(jsonPath)` | 读取 plugin.json |
| `_getProvider(name)` | 获取 Provider 实例 |
| `_log(level, message)` | 内部日志 |

### runtime/state-store

| 方法 | 说明 |
|------|------|
| `_load()` | 加载状态（带缓存） |
| `_getNested(obj, key)` | 获取嵌套值 |
| `_setNested(obj, key, value)` | 设置嵌套值 |
| `_deleteNested(obj, key)` | 删除嵌套值 |
| `_flattenKeys(obj, prefix)` | 递归展平对象为点记法键 |

### runtime/config-manager

| 方法 | 说明 |
|------|------|
| `_getYamlConfig()` | 加载并缓存 YAML 配置 |
| `_getNested(obj, key)` | 获取嵌套值 |
| `_setNested(obj, key, value)` | 设置嵌套值 |
| `_deleteNested(obj, key)` | 删除嵌套值 |
| `_findProjectRoot()` | 查找项目根目录 |

### runtime/resolve-plugin-path

| 方法 | 说明 |
|------|------|
| `resolveNpmPath(source, pluginName)` | 解析 npm 包路径 |
| `findPackageRoot(startPath)` | 查找包根目录 |

### runtime/plugin-validator

| 方法 | 说明 |
|------|------|
| `loadPluginSchema()` | 加载 JSON Schema 定义 |
| `_tryLoadAjv()` | 尝试加载 ajv 模块 |

### runtime/yaml-parser

| 方法 | 说明 |
|------|------|
| `parseNestedBlock(lines, startIdx, parentIndent)` | 解析嵌套 YAML 块 |
| `parseChildLines(childLines, rawEndIdx)` | 解析子行 |
| `parseListItems(childLines)` | 解析列表项 |
| `collectChildren(childLines, startIdx, parentIndent)` | 收集子行 |
| `parseLineAsObject(text)` | 解析行为对象 |
| `parseObjectItems(childLines)` | 解析对象项 |

### runtime/validator-pipeline

| 方法 | 说明 |
|------|------|
| `_setupEventListeners()` | 注册自动触发验证器的 EventBus 监听器 |
| `_filterValidatorsForPhase(validatorNames, phase)` | 按工作流阶段过滤验证器 |

### runtime/sandbox-context

| 方法 | 说明 |
|------|------|
| `callService(services, method, args)` | 按名称调用服务方法 |
| `sendResponse(respondTo, id, result, error)` | 发送 RPC 响应 |

### runtime/sandbox-worker

| 方法 | 说明 |
|------|------|
| `SandboxContext(name, port)` | Worker 内部的 RPC 代理层 |
| `SandboxContext.prototype.getProvider(name)` | 获取 Provider |
| `SandboxContext.prototype._rpc(method, args)` | 发送 RPC 请求 |

---

## 稳定性承诺

### Public API 契约

1. **SemVer 保障**: @public API 的破坏性变更仅在主版本号（major version）中发生
2. **弃用周期**: 被弃用的 API 至少保留一个次版本（minor version），并在 JSDoc 中标注 `@deprecated`
3. **迁移路径**: 移除 @public API 时，CHANGELOG 中必须说明替代方案
4. **新增不破坏**: 新增 @public API 不构成破坏性变更

### Experimental API 变更策略

1. **无兼容保证**: @experimental API 可在任何版本中变更
2. **无弃用周期**: 可直接移除，无需提前通知
3. **推荐使用方式**: 使用时应在代码中添加版本检查或 try-catch
4. **反馈渠道**: 欢迎通过 GitHub Issues 提交关于 experimental API 的反馈

### 版本对照

| 版本范围 | Public API 稳定性 | Experimental API 可用性 |
|------|------|------|
| 0.1.x | 初始公共 API | 沙箱相关功能 |
| 0.2.x | 保持兼容 | 可能扩展或调整 |
| 1.0.0 | 长期稳定 | 待定 |
