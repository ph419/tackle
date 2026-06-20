/**
 * Unit tests for loop-executor factory (WP-185-impl)
 * Run with: node --test test/runtime/test-loop-executor.js
 *
 * 覆盖：
 *   - createExecutor('local') / ('claude') 路由到正确实现
 *   - 默认 provider='local'
 *   - createExecutor(opts) 单参调用（opts.provider）
 *   - 未知 provider 抛 UNKNOWN_EXECUTOR（含 available 列表）
 *   - listProviders 返回注册名
 *   - opts 透传（rateLimitPerHour 等到达具体 executor）
 *   - 所有 provider 返回同一接口契约 { name, run, config }
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');

var loopExecutor = require('../../plugins/runtime/loop-executor');

// ─────────────────────────────────────────────
// Section 1: provider 路由
// ─────────────────────────────────────────────

test('createExecutor("local") 路由到 executor-local', function () {
  var exec = loopExecutor.createExecutor('local');
  assert.strictEqual(exec.name, 'local');
  assert.strictEqual(typeof exec.run, 'function');
  assert.ok(exec.config && typeof exec.config === 'object');
});

test('createExecutor("claude") 路由到 executor-claude', function () {
  var exec = loopExecutor.createExecutor('claude', { projectRoot: process.cwd() });
  assert.strictEqual(exec.name, 'claude');
  assert.strictEqual(typeof exec.run, 'function');
});

test('默认 provider=local', function () {
  var exec = loopExecutor.createExecutor();
  assert.strictEqual(exec.name, 'local');
});

test('createExecutor(opts) 单参调用：opts.provider 指定 provider', function () {
  var exec = loopExecutor.createExecutor({ provider: 'claude', projectRoot: process.cwd() });
  assert.strictEqual(exec.name, 'claude');
});

test('createExecutor(null) 降级为 local', function () {
  var exec = loopExecutor.createExecutor(null);
  assert.strictEqual(exec.name, 'local');
});

// ─────────────────────────────────────────────
// Section 2: 错误处理
// ─────────────────────────────────────────────

test('未知 provider 抛 UNKNOWN_EXECUTOR 含 available 列表', function () {
  assert.throws(function () {
    loopExecutor.createExecutor('nonexistent');
  }, function (err) {
    return err.code === 'UNKNOWN_EXECUTOR' &&
      err.provider === 'nonexistent' &&
      Array.isArray(err.available) &&
      err.available.indexOf('local') !== -1 &&
      err.available.indexOf('claude') !== -1;
  });
});

// ─────────────────────────────────────────────
// Section 3: listProviders
// ─────────────────────────────────────────────

test('listProviders 返回 local 与 claude', function () {
  var names = loopExecutor.listProviders();
  assert.ok(Array.isArray(names));
  assert.ok(names.indexOf('local') !== -1);
  assert.ok(names.indexOf('claude') !== -1);
});

// ─────────────────────────────────────────────
// Section 4: opts 透传
// ─────────────────────────────────────────────

test('opts 透传到具体 executor（rateLimitPerHour 生效）', async function () {
  var exec = loopExecutor.createExecutor('local', { rateLimitPerHour: 1 });
  assert.strictEqual(exec.config.rateLimitPerHour, 1);
  // 第 1 次通过，第 2 次限流
  var r1 = await exec.run({ wpId: 'WP-1', mode: 'dispatch' });
  var r2 = await exec.run({ wpId: 'WP-2', mode: 'dispatch' });
  assert.strictEqual(r1.passed, true);
  assert.strictEqual(r2.passed, false);
  assert.ok(r2.failedItems.some(function (fi) { return fi.reason === 'rate_limited'; }));
});

test('opts 透传到 claude executor（timeoutMs 生效）', function () {
  var exec = loopExecutor.createExecutor('claude', { timeoutMs: 5000, projectRoot: process.cwd() });
  assert.strictEqual(exec.config.timeoutMs, 5000);
  assert.strictEqual(exec.config.binary, 'claude');
});

// ─────────────────────────────────────────────
// Section 5: 接口契约一致性（local / claude 同构）
// ─────────────────────────────────────────────

test('local 与 claude 实现同一份接口契约 { name, run, config }', function () {
  var local = loopExecutor.createExecutor('local');
  var claude = loopExecutor.createExecutor('claude', { projectRoot: process.cwd() });
  [local, claude].forEach(function (exec) {
    assert.ok(typeof exec.name === 'string' && exec.name, 'name 非空字符串');
    assert.strictEqual(typeof exec.run, 'function', 'run 是函数');
    assert.ok(exec.config && typeof exec.config === 'object', 'config 是对象');
  });
});
