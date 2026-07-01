/**
 * test-loop-dispatch-batch — 并发批调度单测（concurrent-dispatch Step 1 / next-dev-plan Batch 2）
 *
 * 一模块一测试（CI 70% 阈值）。覆盖：
 *   - readyWaveFor：拓扑依赖就绪 / maxConcurrency 限制 / 越界排除 / 降级（无 dependencyGraph）
 *   - dispatchBatch：并发 dispatch / 单失败不阻断同批 / 克隆 pendingAction 仅换 wpId / 空输入兜底
 *   - aggregateCheckResults：全 passed / 部分 failed / rejected 占位 / 空批兜底
 *
 * 不写假测试：用真实 fake executor（run 返回 Promise）+ 真实 readyWaveFor/aggregateCheckResults，
 * 断言真实数据流（含并发与 rejected 语义），非 DI-over-mocking。
 */

var test = require('node:test');
var assert = require('node:assert');
var dispatchBatchLib = require('../../plugins/runtime/loop-dispatch-batch');

function fakeExecutor(runImpl) {
  return { name: 'fake', run: runImpl, config: { model: 'test-model' } };
}

// ─────────────────────────────────────────────
// Section 1: readyWaveFor
// ─────────────────────────────────────────────

test.describe('readyWaveFor', function () {
  test('选依赖全完成的 readyWave，限 maxConcurrency', function () {
    var dg = { nodes: {
      'WP-A': { wpId: 'WP-A', dependencies: ['WP-B'], dependents: [] },
      'WP-B': { wpId: 'WP-B', dependencies: [], dependents: ['WP-A'] },
      'WP-C': { wpId: 'WP-C', dependencies: [], dependents: [] },
    } };
    // pending [A,B,C]，completed=[] → A 依赖 B 未完成，readyWave=[B,C]，max=2 → [B,C]
    var w = dispatchBatchLib.readyWaveFor({
      dependencyGraph: dg, pendingWps: ['WP-A', 'WP-B', 'WP-C'],
      completedSet: [], goalWps: ['WP-A', 'WP-B', 'WP-C'], maxConcurrency: 2,
    });
    assert.deepStrictEqual(w, ['WP-B', 'WP-C']);
  });

  test('B 完成后 A 变 ready', function () {
    var dg = { nodes: {
      'WP-A': { wpId: 'WP-A', dependencies: ['WP-B'], dependents: [] },
      'WP-B': { wpId: 'WP-B', dependencies: [], dependents: ['WP-A'] },
    } };
    var w = dispatchBatchLib.readyWaveFor({
      dependencyGraph: dg, pendingWps: ['WP-A'], completedSet: ['WP-B'],
      goalWps: ['WP-A', 'WP-B'], maxConcurrency: 2,
    });
    assert.deepStrictEqual(w, ['WP-A']);
  });

  test('maxConcurrency=1 → 单 WP（首个 ready，= v0.3.15 串行）', function () {
    var dg = { nodes: { 'WP-B': { dependencies: [] }, 'WP-C': { dependencies: [] } } };
    var w = dispatchBatchLib.readyWaveFor({
      dependencyGraph: dg, pendingWps: ['WP-B', 'WP-C'], completedSet: [],
      goalWps: ['WP-B', 'WP-C'], maxConcurrency: 1,
    });
    assert.deepStrictEqual(w, ['WP-B']);
  });

  test('无 dependencyGraph → 降级原序前 N（= v0.3.15）', function () {
    var w = dispatchBatchLib.readyWaveFor({
      pendingWps: ['WP-X', 'WP-Y', 'WP-Z'], completedSet: [],
      goalWps: ['WP-X', 'WP-Y', 'WP-Z'], maxConcurrency: 2,
    });
    assert.deepStrictEqual(w, ['WP-X', 'WP-Y']);
  });

  test('越界排除（pending 含 goal 外 WP）', function () {
    var w = dispatchBatchLib.readyWaveFor({
      pendingWps: ['WP-Z', 'WP-A'], completedSet: [],
      goalWps: ['WP-A'], maxConcurrency: 5,
    });
    assert.deepStrictEqual(w, ['WP-A']);
  });

  test('maxConcurrency 缺省/非法 → 默认 1', function () {
    var w = dispatchBatchLib.readyWaveFor({
      pendingWps: ['WP-A', 'WP-B'], completedSet: [], goalWps: ['WP-A', 'WP-B'],
    });
    assert.deepStrictEqual(w, ['WP-A']);
    var w2 = dispatchBatchLib.readyWaveFor({
      dependencyGraph: null, pendingWps: ['WP-A', 'WP-B'], completedSet: [],
      goalWps: ['WP-A', 'WP-B'], maxConcurrency: 0,
    });
    assert.deepStrictEqual(w2, ['WP-A']);
  });
});

// ─────────────────────────────────────────────
// Section 2: dispatchBatch
// ─────────────────────────────────────────────

test.describe('dispatchBatch', function () {
  test('并发 dispatch + 单失败不阻断同批', async function () {
    var exec = fakeExecutor(function (pa) {
      if (pa.wpId === 'WP-B') return Promise.reject(new Error('boom'));
      var passed = pa.wpId === 'WP-A';
      return Promise.resolve({
        wpId: pa.wpId, passed: passed,
        failedItems: passed ? [] : [{ wpId: pa.wpId, category: 't', id: 't1', reason: 'r' }],
        summary: { total: 1, passed: passed ? 1 : 0, failed: passed ? 0 : 1 },
      });
    });
    var results = await dispatchBatchLib.dispatchBatch({
      executor: exec, pendingActionTemplate: { mode: 'dispatch', strategy: 'full_restart' },
      wpIds: ['WP-A', 'WP-B', 'WP-C'],
    });
    assert.strictEqual(results.length, 3, '单失败不阻断：三个都返回');
    assert.strictEqual(results[0].wpId, 'WP-A');
    assert.strictEqual(results[0].status, 'fulfilled');
    assert.strictEqual(results[0].checkResult.passed, true);
    assert.strictEqual(results[1].wpId, 'WP-B');
    assert.strictEqual(results[1].status, 'rejected');
    assert.strictEqual(results[2].wpId, 'WP-C');
    assert.strictEqual(results[2].checkResult.passed, false);
  });

  test('克隆 pendingAction 仅换 wpId（保留 mode/strategy/failingDrivers）', async function () {
    var seen = [];
    var exec = fakeExecutor(function (pa) {
      seen.push(pa);
      return Promise.resolve({ wpId: pa.wpId, passed: true, failedItems: [], summary: { total: 1, passed: 1, failed: 0 } });
    });
    await dispatchBatchLib.dispatchBatch({
      executor: exec,
      pendingActionTemplate: { mode: 'retry', strategy: 'checkpoint_resume', failingDrivers: ['d1'] },
      wpIds: ['WP-X', 'WP-Y'],
    });
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(seen[0].mode, 'retry');
    assert.strictEqual(seen[0].strategy, 'checkpoint_resume');
    assert.deepStrictEqual(seen[0].failingDrivers, ['d1']);
    assert.strictEqual(seen[0].wpId, 'WP-X');
    assert.strictEqual(seen[1].wpId, 'WP-Y');
  });

  test('空 wpIds / 无 executor → []', async function () {
    var r1 = await dispatchBatchLib.dispatchBatch({
      executor: { run: function () {} }, pendingActionTemplate: {}, wpIds: [],
    });
    assert.deepStrictEqual(r1, []);
    var r2 = await dispatchBatchLib.dispatchBatch({
      executor: null, pendingActionTemplate: {}, wpIds: ['WP-A'],
    });
    assert.deepStrictEqual(r2, []);
  });
});

// ─────────────────────────────────────────────
// Section 3: aggregateCheckResults
// ─────────────────────────────────────────────

test.describe('aggregateCheckResults', function () {
  test('全 passed → passed=true + summary 求和', function () {
    var results = [
      { wpId: 'WP-A', status: 'fulfilled', checkResult: { wpId: 'WP-A', passed: true, failedItems: [], summary: { total: 2, passed: 2, failed: 0 } } },
      { wpId: 'WP-B', status: 'fulfilled', checkResult: { wpId: 'WP-B', passed: true, failedItems: [], summary: { total: 1, passed: 1, failed: 0 } } },
    ];
    var agg = dispatchBatchLib.aggregateCheckResults(results);
    assert.strictEqual(agg.passed, true);
    assert.strictEqual(agg.summary.total, 3);
    assert.strictEqual(agg.summary.passed, 3);
    assert.strictEqual(agg.summary.failed, 0);
    assert.deepStrictEqual(agg._batchWpIds, ['WP-A', 'WP-B']);
  });

  test('部分 failed → passed=false + failedItems 并集', function () {
    var results = [
      { wpId: 'WP-A', status: 'fulfilled', checkResult: { wpId: 'WP-A', passed: true, failedItems: [], summary: { total: 1, passed: 1, failed: 0 } } },
      { wpId: 'WP-B', status: 'fulfilled', checkResult: { wpId: 'WP-B', passed: false, failedItems: [{ wpId: 'WP-B', category: 't', id: 't1', reason: 'r' }], summary: { total: 1, passed: 0, failed: 1 } } },
    ];
    var agg = dispatchBatchLib.aggregateCheckResults(results);
    assert.strictEqual(agg.passed, false);
    assert.strictEqual(agg.summary.total, 2);
    assert.strictEqual(agg.summary.failed, 1);
    assert.strictEqual(agg.failedItems.length, 1);
    assert.strictEqual(agg.failedItems[0].wpId, 'WP-B');
  });

  test('rejected → passed=false + 占位 failedItem（带 wpId 供 evaluator 归一化）', function () {
    var results = [
      { wpId: 'WP-A', status: 'fulfilled', checkResult: { wpId: 'WP-A', passed: true, failedItems: [], summary: { total: 1, passed: 1, failed: 0 } } },
      { wpId: 'WP-B', status: 'rejected', reason: new Error('boom') },
    ];
    var agg = dispatchBatchLib.aggregateCheckResults(results);
    assert.strictEqual(agg.passed, false);
    assert.strictEqual(agg.failedItems.length, 1);
    assert.strictEqual(agg.failedItems[0].wpId, 'WP-B');
  });

  test('空批 → passed=false 兜底（防 engine 误判达成）', function () {
    var agg = dispatchBatchLib.aggregateCheckResults([]);
    assert.strictEqual(agg.passed, false);
    assert.strictEqual(agg.summary.total, 0);
  });

  test('批内部分失败 + executor failedItems 无 wpId → 聚合补条目级 wpId（正确归因，review major）', function () {
    // 模拟真实 executor：WP-2 failed，failedItems 不带 fi.wpId（executor-local/claude/default 口径）
    var results = [
      { wpId: 'WP-1', status: 'fulfilled', checkResult: { wpId: 'WP-1', passed: true, failedItems: [], summary: { total: 1, passed: 1, failed: 0 } } },
      { wpId: 'WP-2', status: 'fulfilled', checkResult: { wpId: 'WP-2', passed: false, failedItems: [{ id: 't1', category: '测试', reason: '缺边界' }], summary: { total: 1, passed: 0, failed: 1 } } },
    ];
    var agg = dispatchBatchLib.aggregateCheckResults(results);
    assert.strictEqual(agg.passed, false);
    assert.strictEqual(agg.failedItems.length, 1);
    // 关键：失败项归因到 WP-2（真正失败的 WP），而非聚合顶层 wpIds[0]=WP-1（已 passed）
    assert.strictEqual(agg.failedItems[0].wpId, 'WP-2', 'fi.wpId 补全 → 归因到 WP-2');
    assert.strictEqual(agg.failedItems[0].id, 't1', '保留原 failedItem 字段');
    assert.strictEqual(agg.failedItems[0].reason, '缺边界');
  });
});
