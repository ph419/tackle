# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.13] - 2026-04-24

### Fixed

- `package.json` 的 `files` 字段缺少 `templates/`，导致 npm 安装后 `init` 命令找不到 `harness-config.yaml` 模板文件

## [0.0.12] - 2026-04-22

### Added

- Progress Tracker 记录进度时同步更新 `docs/wp/WP-XXX.md` 状态字段和子任务状态
- Format A（基本信息表 + 子工作包列表表，WP-029~035）和 Format B（`### 状态` 独立节 + 任务列表表，WP-001~028）全覆盖
- 验收标准 checkbox 自动勾选（`- [ ]` → `- [x]`）

### Fixed

- Watchdog Provider 代码规范化（`var` → `const`）
- Watchdog 前台模式阻塞修复（`return new Promise(() => {})`）
- `daemon-status.json` 新增 `state` 字段，支持 paused 状态显示
- Watchdog `pause` 命令异步化
- Watchdog 与 Watchdog Manager 插件启用

## [0.0.11] - 2026-04-20

### Added

- Agent Dispatcher 并发控制：支持按时段调度子代理并发上限（WP-035）
- `agent_dispatcher.concurrency` 配置节（`harness-config.yaml` + `plugin-registry.json`）
- `get_max_concurrent()` / `is_time_in_range()` 辅助函数，支持跨午夜时段
- `harness-build.js` 多节 YAML 解析重构，支持 `context_window` 和 `agent_dispatcher` 两个独立配置节
- `_injectContextConfig` 按插件名分发 `CONTEXT-CONFIG` / `AGENT-DISPATCHER-CONFIG` 注入
- 并发控制测试套件 (`tests/wp-035-concurrency-test.js`，8 组测试)
- `CHANGELOG.md` 项目更新日志

## [0.0.10] - 2026-04-20

### Added

- Agent Dispatcher 1:1 工作包-Subagent 映射校验，防止重复创建和重复销毁

## [0.0.9] - 2026-04-18

### Changed

- CLI 输出优化，更新测试用例

## [0.0.8] - 2026-04-16

### Fixed

- CLI `--help` 标志、status 统计、config 解析等问题（WP-020/WP-021）
- CLI stale output 清理和 status 时间戳修复（WP-020/WP-021）
- Validator phase targeting 配置（WP-029）

### Added

- 配置校验器和测试套件
- npm 打包支持

## [0.0.7] - 2026-04-12

### Added

- PluginLoader 真实模块加载和 PluginContext 依赖注入（WP-013）
- Provider DI、HookDispatcher、ValidatorPipeline（WP-014 ~ WP-016）

## [0.0.6] - 2026-04-08

### Fixed

- Skill 文件中已删除文件的过期引用
- Quick-mode 触发词补充"不要直接执行"关键词

### Added

- Watchdog daemon 集成为可选 Provider 插件

## [0.0.5] - 2026-04-05

### Added

- SessionStart Hook：通过 system-reminder 注入 plan-mode 规则到 CLAUDE.md

## [0.0.4] - 2026-04-02

### Changed

- 拆分 skill-agent-dispatcher 参考文档

## [0.0.3] - 2026-03-30

### Changed

- 批量执行技能改为 1:1 工作包-Subagent 绑定模式
- 包名从 `tackle` 重命名为 `tackle-harness`

## [0.0.2] - 2026-03-28

### Added

- 上下文窗口管理：防止任务创建技能处理大文档时上下文溢出
- 英文触发词支持

## [0.0.1] - 2026-03-27

### Added

- 初始发布：AI Agent Harness v3.0 插件框架
- 12 个 Skill 插件、1 个 Hook 插件、2 个 Validator、3 个 Provider
- CLI 工具：`build`、`validate`、`init`
- 插件注册表 (`plugin-registry.json`)
- 运行时层：harness-build、plugin-loader、event-bus、state-store、config-manager、logger

[0.0.13]: https://github.com/ph419/tackle/compare/v0.0.12...v0.0.13
[0.0.12]: https://github.com/ph419/tackle/compare/v0.0.11...v0.0.12
[0.0.11]: https://github.com/ph419/tackle/compare/v0.0.10...v0.0.11
[0.0.10]: https://github.com/ph419/tackle/compare/v0.0.9...v0.0.10
[0.0.9]: https://github.com/user/tackle-harness/compare/v0.0.8...v0.0.9
[0.0.8]: https://github.com/user/tackle-harness/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/user/tackle-harness/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/user/tackle-harness/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/user/tackle-harness/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/user/tackle-harness/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/user/tackle-harness/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/user/tackle-harness/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/user/tackle-harness/releases/tag/v0.0.1
