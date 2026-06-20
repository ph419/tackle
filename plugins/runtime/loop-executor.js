/**
 * Loop Executor Factory — provider 路由层（WP-185-impl）
 *
 * @module loop-executor
 *
 * 职责：按 `opts.provider`（或 `opts.name`）分发到具体 executor 实现，统一
 * `createExecutor(opts)` 工厂入口。driver 与具体 executor 实现解耦——driver 只认
 * `createExecutor('local'|'claude'|'glm', opts)`，不直接 require 具体 executor 模块。
 *
 * 设计约束（docs/plan/agentic-loop-node-driver.md 硬约束 #3 / 成功标准 #4）：
 *   - provider 解耦点是 `executor.run()`；新增 executor-glm.js 接智谱 Coding Plan 时，
 *     driver 与 engine 零改动——只需在此注册一行 + 新建 executor-glm.js。
 *   - 所有 executor 实现同一份接口契约：{ name, run(pendingAction)->Promise<CheckResult>, config }
 *
 * 注册表（REGISTRY）：provider 名 → 模块 require 函数（惰性 require，避免未用 provider
 *   的依赖在 driver 启动时被加载，如 executor-claude 在 --executor=local 场景无需 spawn）。
 */

'use strict';

// ---------------------------------------------------------------------------
// provider 注册表
// ---------------------------------------------------------------------------

/**
 * provider 名 → 惰性 require 工厂。
 * 新增 executor：在此加一行 `'glm': function(){ return require('./executor-glm'); }`。
 */
var REGISTRY = {
  local: function () { return require('./executor-local'); },
  claude: function () { return require('./executor-claude'); },
  // WP-188：智谱 GLM Coding Plan，复用 claude CLI + 智谱 anthropic 兼容端点（享套餐额度）
  glm: function () { return require('./executor-glm'); },
};

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 列出已注册的 provider 名（供 driver 在「未知 executor」时打印可用列表）。
 * @returns {string[]}
 */
function listProviders() {
  return Object.keys(REGISTRY);
}

/**
 * 创建 executor 实例（provider 路由）。
 *
 * @param {string} [provider='local'] provider 名（local / claude / glm ...）
 * @param {object} [opts] 透传给具体 executor.createExecutor 的选项
 * @returns {{ name:string, run:Function, config:object }}
 * @throws {Error} provider 未注册时抛错（driver 捕获后打印可用列表）
 */
function createExecutor(provider, opts) {
  // 兼容 createExecutor(opts) 单参调用（此时 opts.provider 指定 provider）
  if (provider && typeof provider === 'object') {
    opts = provider;
    provider = opts.provider || 'local';
  }
  provider = provider || 'local';
  opts = opts || {};

  var factory = REGISTRY[provider];
  if (!factory) {
    var err = new Error('unknown executor provider: ' + provider +
      ' (available: ' + listProviders().join(', ') + ')');
    err.code = 'UNKNOWN_EXECUTOR';
    err.provider = provider;
    err.available = listProviders();
    throw err;
  }

  var mod;
  try {
    mod = factory();
  } catch (e) {
    var loadErr = new Error('executor module load failed (' + provider + '): ' +
      (e && e.message ? e.message : String(e)));
    loadErr.code = 'EXECUTOR_LOAD_FAILED';
    loadErr.provider = provider;
    throw loadErr;
  }

  if (!mod || typeof mod.createExecutor !== 'function') {
    throw new Error('executor module "' + provider + '" missing createExecutor export');
  }

  return mod.createExecutor(opts);
}

module.exports = {
  createExecutor: createExecutor,
  listProviders: listProviders,
  _REGISTRY: REGISTRY,
};
