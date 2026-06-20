/**
 * Unit tests for executor-local (WP-185-impl)
 * Run with: node --test test/runtime/test-executor-local.js
 *
 * 覆盖：
 *   - run() 默认返回固定 passed CheckResult（结构符合 reflection-evaluator 消费契约）
 *   - wpId 透传（pendingAction.wpId → CheckResult.wpId）
 *   - simulateFailure 模式返回 passed:false + failedItems
 *   - 限流（rateLimitPerHour 超限返回 rate_limited）
 *   - CheckResult 结构完整性（summary.{total,passed,failed} / categories / failedItems）
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');

var executorLocal = require('../../plugins/runtime/executor-local');
var createExecutor = executorLocal.createExecutor;

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makePending(wpId, mode) {
  return {
    wpId: wpId || 'WP-1',
    mode: mode || 'dispatch',
    strategy: 'full_restart',
    failingDrivers: [],
    createdAt: new Date().toISOString(),
    loopId: 'loop-test',
  };
}

// ─────────────────────────────────────────────
// Section 1: 默认 passed 行为与 CheckResult 契约
// ─────────────────────────────────────────────

test('run() 默认返回 passed:true CheckResult', async function () {
  var exec = createExecutor();
  var result = await exec.run(makePending('WP-1'));

  assert.strictEqual(result.passed, true);
  assert.strictEqual(result.wpId, 'WP-1');
  assert.strictEqual(result.summary.passed, result.summary.total);
  assert.strictEqual(result.summary.failed, 0);
});

test('CheckResult 结构完整（summary/categories/failedItems）', async function () {
  var exec = createExecutor();
  var result = await exec.run(makePending('WP-2'));

  // 结构契约（reflection-evaluator.proximityFromChecklist / failingDriversFromChecklist 消费）
  assert.ok(typeof result.wpId === 'string');
  assert.ok(typeof result.passed === 'boolean');
  assert.ok(result.summary && typeof result.summary === 'object');
  assert.ok(typeof result.summary.total === 'number');
  assert.ok(typeof result.summary.passed === 'number');
  assert.ok(typeof result.summary.failed === 'number');
  assert.ok(Array.isArray(result.categories));
  assert.ok(Array.isArray(result.failedItems));
  // summary 自洽：total = passed + failed
  assert.strictEqual(result.summary.total, result.summary.passed + result.summary.failed);
});

test('wpId 透传：pendingAction.wpId → CheckResult.wpId', async function () {
  var exec = createExecutor();
  var r1 = await exec.run(makePending('WP-101'));
  var r2 = await exec.run(makePending('WP-A'));
  assert.strictEqual(r1.wpId, 'WP-101');
  assert.strictEqual(r2.wpId, 'WP-A');
});

test('空 pendingAction 降级 wpId=unknown 不抛异常', async function () {
  var exec = createExecutor();
  var result = await exec.run({});
  assert.strictEqual(result.wpId, 'unknown');
  assert.strictEqual(result.passed, true);
});

// ─────────────────────────────────────────────
// Section 2: simulateFailure 模式
// ─────────────────────────────────────────────

test('simulateFailure + failRate=1 强制返回 passed:false + failedItems', async function () {
  var exec = createExecutor({ simulateFailure: true, failRate: 1.0 });
  var result = await exec.run(makePending('WP-3'));

  assert.strictEqual(result.passed, false);
  assert.ok(result.failedItems.length > 0);
  assert.strictEqual(result.summary.failed, result.summary.total);
  assert.strictEqual(result.summary.passed, 0);
});

test('simulateFailure + failRate=0 永不失败', async function () {
  var exec = createExecutor({ simulateFailure: true, failRate: 0.0 });
  for (var i = 0; i < 10; i++) {
    var r = await exec.run(makePending('WP-' + i));
    assert.strictEqual(r.passed, true);
  }
});

// ─────────────────────────────────────────────
// Section 3: 限流
// ─────────────────────────────────────────────

test('rateLimitPerHour 超限返回 rate_limited 失败', async function () {
  var exec = createExecutor({ rateLimitPerHour: 3 });
  // 前 3 次通过
  for (var i = 0; i < 3; i++) {
    var ok = await exec.run(makePending('WP-' + i));
    assert.strictEqual(ok.passed, true, 'call ' + i + ' should pass');
  }
  // 第 4 次被限流
  var blocked = await exec.run(makePending('WP-blocked'));
  assert.strictEqual(blocked.passed, false);
  assert.ok(blocked.failedItems.some(function (fi) {
    return fi.reason === 'rate_limited';
  }), 'should contain rate_limited reason');
});

test('限流不污染 wpId 透传', async function () {
  var exec = createExecutor({ rateLimitPerHour: 1 });
  await exec.run(makePending('WP-first'));
  var blocked = await exec.run(makePending('WP-second'));
  assert.strictEqual(blocked.wpId, 'WP-second');
  assert.strictEqual(blocked.passed, false);
});

// ─────────────────────────────────────────────
// Section 4: 内部工具（暴露的 _build* ）
// ─────────────────────────────────────────────

test('_buildPassedChecklist 产出合法 CheckResult', function () {
  var chk = executorLocal._buildPassedChecklist('WP-9');
  assert.strictEqual(chk.wpId, 'WP-9');
  assert.strictEqual(chk.passed, true);
  assert.ok(chk.summary.total > 0);
  assert.deepStrictEqual(chk.failedItems, []);
});

test('_buildFailedChecklist 含失败原因', function () {
  var chk = executorLocal._buildFailedChecklist('WP-9', 'boom');
  assert.strictEqual(chk.passed, false);
  assert.ok(chk.failedItems.length > 0);
  assert.strictEqual(chk.failedItems[0].reason, 'boom');
});
