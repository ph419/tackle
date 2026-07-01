/**
 * Loop Dispatch Batch — 并发批调度（concurrent-dispatch Step 1 / next-dev-plan Batch 2）
 *
 * @module loop-dispatch-batch
 *
 * 把 driver 主循环的「单 WP 串行 dispatch」升级为「readyWave 批并发 dispatch」：
 *   - readyWaveFor：从 pending 中选出依赖全完成（readyWave）的子集，限 maxConcurrency
 *   - dispatchBatch：Promise.all 并发 executor.run（每 spawn 克隆 pendingAction 仅换 wpId），
 *     单失败不阻断同批（task 内部 catch 成 settled）
 *   - aggregateCheckResults：批内 N 个 CheckResult 合并为单 CheckResult（reflect 评分用）
 *
 * 并发安全前提（决策 1：单实例 + 容忍放大）：
 *   driver 复用单 executor 实例，executor.run 的限流段（callTimestamps filter/length/push）
 *   + quota 前置检查都在第一个 await（new Promise）前同步执行 → Node 单线程下原子串行，
 *   限流天然并发安全（批内 N 个 push 串行，rateLimitPerHour 对批总 spawn 计数，无需 race-free）。
 *   quota 额度（5h 窗口）检查-消耗间隙：批内 N 个 spawn 都基于批前额度通过检查，N 个 close
 *   回调后才计入 → 批内 N 倍消耗可能超 softThreshold，由 executor softThreshold(0.9) 下批降速
 *   + coordinator hardThreshold(0.95) 熔断兜底，资源浪费有界。默认 maxConcurrency=1 零放大。
 *
 * 不变量（Step 1 守住）：
 *   - engine index.js / loop-actuator.js / plan-reader.js git diff 为空（WP-191）
 *   - maxConcurrency=1 时行为与 v0.3.15 串行完全一致（回退安全）
 *
 * 已知限制（仅 N>1 触发，N=1 完全无影响）：
 *   - ~~工作树脏度信号串扰~~（Step 2 已解决）：v0.4.0 的 readWorktreeDirty 共用
 *     config.projectRoot 致批内 N 个 spawn 串扰。Step 2（concurrent-dispatch Step 2 /
 *     per-WP git worktree 隔离）已落地——driver 为批内每 WP 建独立 git worktree，经
 *     dispatchBatch 的 wpProjectRoots 透传给 executor.run 的 pendingAction.projectRoot，
 *     脏度检测 per-WP 准确。非 git 仓库 / local executor / 无 --loop-id / 降级路径仍走
 *     旧行为（批级串扰），另由 coordinator hardThreshold(0.95) + max_iterations 双兜底兜住。
 *     --no-progress-detect flag 作为 escape hatch（强制批模式 noProgress 归零不累计）。
 *   - quota 额度放大：见上方「并发安全前提」（容忍 + softThreshold/hardThreshold 兜底）。
 *   - trace 观测冗余：批内 N 条 round record 共享同一轮 engine phaseTimings（每条自带
 *     dispatchedWp 可区分；按 iteration 聚合统计时注意同轮多条）。
 *
 * 设计依据：docs/reports/2026-07-01_next-dev-plan.md §3.7（gitignored，运行时产物）
 */

'use strict';

/**
 * 判断 wpId 的依赖是否全部落在 completedSet 内（readyWave 判定）。
 * 与 engine _think 的 isDepsReady 同口径（Step 0 readyWave 逻辑的批量化）。
 * @param {string} wid
 * @param {object|null} depNodes dependencyGraph.nodes（{wpId:{dependencies:[...]}}）
 * @param {string[]} completedSet 已完成 WP id
 * @returns {boolean}
 */
function isDepsReady(wid, depNodes, completedSet) {
  if (!depNodes) return true; // 无拓扑信息 → 视为 ready（降级 = v0.3.15）
  var node = depNodes[wid];
  if (!node) return true; // 节点缺失，视为无依赖
  var deps = node.dependencies || [];
  for (var d = 0; d < deps.length; d++) {
    if (completedSet.indexOf(deps[d]) === -1) return false; // 依赖未完成
  }
  return true;
}

/**
 * 从 pendingWps 中选出 readyWave：依赖全完成 + 在 goal 范围内，限 maxConcurrency 个。
 *
 * readyWave 语义：拓扑入度 0（依赖全 completed）的 pending WP，可安全并发 dispatch
 * （无依赖关系，互不干扰）。maxConcurrency 限制批大小（默认 1 = 串行 = v0.3.15）。
 *
 * @param {object} opts
 * @param {object} [opts.dependencyGraph] {nodes,edges,order,hasCycle,cycle}（plan-reader 产出）
 * @param {string[]} opts.pendingWps 未完成 WP（goalWps 减 completed，建议按拓扑序排）
 * @param {string[]} opts.completedSet 已完成 WP id
 * @param {string[]|null} [opts.goalWps] goal 范围（越界保护；null/缺省不限制）
 * @param {number} [opts.maxConcurrency=1] 最大并发数
 * @returns {string[]} readyWave wpId[]（≤ maxConcurrency）
 */
function readyWaveFor(opts) {
  opts = opts || {};
  var depNodes = (opts.dependencyGraph && opts.dependencyGraph.nodes)
    ? opts.dependencyGraph.nodes : null;
  var pending = Array.isArray(opts.pendingWps) ? opts.pendingWps : [];
  var completedSet = Array.isArray(opts.completedSet) ? opts.completedSet : [];
  var goalWps = Array.isArray(opts.goalWps) ? opts.goalWps : null;
  var max = (typeof opts.maxConcurrency === 'number' && opts.maxConcurrency > 0)
    ? Math.floor(opts.maxConcurrency) : 1;
  var out = [];
  for (var i = 0; i < pending.length && out.length < max; i++) {
    var wid = pending[i];
    if (goalWps && goalWps.indexOf(wid) === -1) continue; // 越界保护
    if (!isDepsReady(wid, depNodes, completedSet)) continue; // 依赖未就绪
    out.push(wid);
  }
  return out;
}

/**
 * 并发 dispatch 一个 readyWave：每个 wpId 克隆 pendingActionTemplate（仅换 wpId），
 * executor.run 并发，Promise.all 收集（每个 task 内部 catch 成 settled，单失败不阻断同批）。
 *
 * concurrent-dispatch Step 2（per-WP worktree 隔离）：
 *   opts.wpProjectRoots（{wpId: wtPath}）注入每 WP 的 per-call projectRoot override，
 *   使 executor.run 在各自 worktree cwd 跑 → readWorktreeDirty per-WP 准确、互不串扰。
 *   缺省/某 WP 无映射 → 不注入（executor 走 config.projectRoot = v0.4.0 串扰行为，回退安全）。
 *
 * @param {object} opts
 * @param {object} opts.executor executor 实例（单实例，run 限流段同步原子故并发安全）
 * @param {object} opts.pendingActionTemplate actuator 产出的 pendingAction 模板（mode/strategy/...）
 * @param {string[]} opts.wpIds readyWave（≤ maxConcurrency）
 * @param {object} [opts.wpProjectRoots] per-WP worktree 路径映射（{wpId: wtPath}）；Step 2 隔离用
 * @returns {Promise<Array<{wpId:string,status:'fulfilled'|'rejected',checkResult?:object,reason?:*}>>}
 */
async function dispatchBatch(opts) {
  opts = opts || {};
  var executor = opts.executor;
  var template = opts.pendingActionTemplate || {};
  var wpIds = Array.isArray(opts.wpIds) ? opts.wpIds : [];
  var wpProjectRoots = (opts.wpProjectRoots && typeof opts.wpProjectRoots === 'object')
    ? opts.wpProjectRoots : null;
  if (!executor || typeof executor.run !== 'function' || wpIds.length === 0) {
    return [];
  }
  var tasks = wpIds.map(function (wpId) {
    // 克隆 pendingAction 仅换 wpId（保留 mode/strategy/context/failingDrivers/createdAt/loopId）
    var pa = {};
    for (var k in template) {
      if (Object.prototype.hasOwnProperty.call(template, k)) pa[k] = template[k];
    }
    pa.wpId = wpId;
    // Step 2：per-WP worktree projectRoot override（wpProjectRoots[wpId] 为 null/undefined 时不注入）
    if (wpProjectRoots && wpProjectRoots[wpId]) {
      pa.projectRoot = wpProjectRoots[wpId];
    }
    return executor.run(pa).then(
      function (checkResult) {
        return { wpId: wpId, status: 'fulfilled', checkResult: checkResult };
      },
      function (err) {
        // 单失败不阻断同批：rejected 也 resolve 成 settled 条目
        return { wpId: wpId, status: 'rejected', reason: err };
      }
    );
  });
  // 每个 task 都 resolve（不 reject），Promise.all 等价 allSettled
  return Promise.all(tasks);
}

/**
 * 把批内 N 个 CheckResult 合并为单 CheckResult，供 reflection-evaluator 评分 proximity。
 *
 * 合并语义：
 *   - passed = 全部 fulfilled 且 checkResult.passed（任一失败/拒绝 → passed=false）
 *   - failedItems = 全部 fulfilled 的 failedItems 并集 + rejected/no-result 占位项（带 wpId 供 evaluator 归一化）
 *   - summary = {total:Σ, passed:Σ, failed:Σ}
 *   - wpId = 首个 wpId（reflect 单 WP 评分粒度兼容）；_batchWpIds 保留全集供追溯
 *
 * 设计：driver 层回填策略（lastChecklist 聚合），不改 reflection-evaluator API、不触 design §5.3
 * （计划 §3.8 的「~5 行内联」扩展为可测的独立函数）。
 *
 * @param {Array<{wpId:string,status:string,checkResult?:object}>} results dispatchBatch 返回值
 * @returns {object} 合并 CheckResult（含 wpId/passed/failedItems/summary/_batchWpIds）
 */
function aggregateCheckResults(results) {
  results = Array.isArray(results) ? results : [];
  var allPassed = true;
  var anyObserved = false;
  var failedItems = [];
  var wpIds = [];
  var total = 0;
  var passedCount = 0;
  var failedCount = 0;
  for (var i = 0; i < results.length; i++) {
    var r = results[i];
    if (!r) continue;
    var cr = r.checkResult;
    if (r.status !== 'fulfilled' || !cr) {
      // rejected 或无 checkResult → 计为失败项（带 wpId 供 reflection-evaluator 归一化）
      allPassed = false;
      if (r.wpId) {
        wpIds.push(r.wpId);
        total += 1;
        failedCount += 1;
        failedItems.push({
          wpId: r.wpId,
          category: 'executor',
          id: 'dispatch_' + (r.status === 'rejected' ? 'rejected' : 'no_result'),
          reason: r.status === 'rejected' ? String(r.reason) : 'no checkResult',
        });
      }
      continue;
    }
    anyObserved = true;
    if (r.wpId) wpIds.push(r.wpId);
    if (!cr.passed) allPassed = false;
    if (cr.failedItems && cr.failedItems.length) {
      for (var f = 0; f < cr.failedItems.length; f++) {
        var fi = cr.failedItems[f];
        // 补条目级 wpId：executor 产出的 failedItems 不带 fi.wpId（executor-local/claude/default
        // 的 buildFailedChecklist 仅 id/category/reason）。批内聚合若不补，reflection-evaluator
        // 的 failingWpsFromChecklist 会因 fi.wpId 缺失回退到聚合顶层 wpId（=wpIds[0]），把批内
        // 某 WP 的失败错归因到首个 WP（可能已 passed）→ engine retry/resplit 指向错误 WP。
        // 补 r.wpId 让 fi.wpId 优先归因到真正失败的 WP（review major 修复）。
        if (fi && typeof fi === 'object' && !fi.wpId && r.wpId) {
          var _fi = {};
          for (var kk in fi) {
            if (Object.prototype.hasOwnProperty.call(fi, kk)) _fi[kk] = fi[kk];
          }
          _fi.wpId = r.wpId;
          fi = _fi;
        }
        failedItems.push(fi);
      }
    }
    if (cr.summary && typeof cr.summary === 'object') {
      total += cr.summary.total || 0;
      passedCount += cr.summary.passed || 0;
      failedCount += cr.summary.failed || 0;
    } else {
      // 无 summary：按单条计
      total += 1;
      if (cr.passed) passedCount += 1; else failedCount += 1;
    }
  }
  // 空批兜底（不该发生，防御）：passed=false 防止 engine 误判达成
  if (!anyObserved && wpIds.length === 0) {
    return { wpId: 'batch', passed: false, failedItems: [], summary: { total: 0, passed: 0, failed: 0 } };
  }
  return {
    wpId: wpIds[0] || 'batch',
    passed: allPassed,
    failedItems: failedItems,
    summary: { total: total, passed: passedCount, failed: failedCount },
    _batchWpIds: wpIds,
  };
}

module.exports = {
  readyWaveFor: readyWaveFor,
  dispatchBatch: dispatchBatch,
  aggregateCheckResults: aggregateCheckResults,
  // 暴露内部函数便于单元测试（一模块一测试 CI 70% 阈值）
  _isDepsReady: isDepsReady,
};
