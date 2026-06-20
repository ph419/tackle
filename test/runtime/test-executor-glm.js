/**
 * Unit tests for executor-glm (WP-188)
 * Run with: node --test test/runtime/test-executor-glm.js
 *
 * 覆盖（用 fake spawn + 注入时间，遵循 codebase DI-over-mocking 哲学）：
 *   - spawn 注入智谱端点环境变量（ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN）
 *   - spawn args 含 --model <glm-model>
 *   - prompt 复用 claude 模板（含 wpId/mode/json:machine-readable 要求）
 *   - 5h 窗口额度感知：接近软上限 → quota_exhausted（不 spawn）
 *   - 高峰系数：14:00-18:00 UTC+8 GLM-5.x 按 3x 计入窗口
 *   - 缺 API key → quota_exhausted
 *   - stdout → checklist 解析（复用 claude 解析，passed/failed/降级）
 *   - 超时 / spawn 失败 / 非0退出降级
 *   - 内部工具：buildGlmArgs / buildAnthropicEnv / quotaCostFactor / isPeakHour
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var EventEmitter = require('events');
var os = require('os');
var fs = require('fs');
var path = require('path');

var executorGlm = require('../../plugins/runtime/executor-glm');
var createExecutor = executorGlm.createExecutor;

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/** fake spawn（模拟 child_process.spawn 返回的子进程），记录 binary/args/spawnOpts。 */
function makeFakeSpawn(opts) {
  opts = opts || {};
  var calls = [];
  var fakeSpawn = function (binary, args, spOpts) {
    calls.push({ binary: binary, args: args, opts: spOpts });
    if (opts.spawnError) throw opts.spawnError;
    var child = new EventEmitter();
    // 暴露最后一次 spawn 的子进程，供 prompt(stdin) 断言读取 _stdinBuf
    fakeSpawn.lastChild = child;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    // 可写的 stdin stub：记录写入内容（prompt 走 stdin）
    child._stdinBuf = '';
    child.stdin = {
      write: function (data) { child._stdinBuf += String(data); return true; },
      end: function () { child._stdinEnded = true; },
      on: function (_ev, _fn) { return this; },
      once: function (_ev, _fn) { return this; },
    };
    child.killed = false;
    child.kill = function (sig) { child.killed = true; child._killedWith = sig; };
    child._calls = calls;

    var emitClose = function () {
      if (opts.emitError) {
        child.emit('error', new Error('simulated spawn error'));
      } else {
        child.emit('close', opts.exitCode === undefined ? 0 : opts.exitCode);
      }
    };

    if (opts.delayMs && opts.delayMs > 0) {
      setTimeout(function () {
        if (opts.stdout) child.stdout.emit('data', opts.stdout);
        if (opts.stderr) child.stderr.emit('data', opts.stderr);
        emitClose();
      }, opts.delayMs);
    } else {
      process.nextTick(function () {
        if (opts.stdout) child.stdout.emit('data', opts.stdout);
        if (opts.stderr) child.stderr.emit('data', opts.stderr);
        emitClose();
      });
    }
    return child;
  };
  fakeSpawn.calls = calls;
  fakeSpawn.lastChild = null;
  return fakeSpawn;
}

/** claude --output-format json 的 stdout（含 json:machine-readable block）。 */
function makeClaudeStdout(checkResult) {
  var text = '执行完成。\n```json:machine-readable\n' +
    JSON.stringify(checkResult, null, 2) + '\n```\n';
  return JSON.stringify({ type: 'result', result: text });
}

function makePending(wpId, mode, extra) {
  var p = {
    wpId: wpId || 'WP-1',
    mode: mode || 'dispatch',
    strategy: 'full_restart',
    failingDrivers: [],
    createdAt: new Date().toISOString(),
    loopId: 'loop-test',
  };
  if (extra) for (var k in extra) p[k] = extra[k];
  return p;
}

/** 构造一个固定返回指定 UTC 时刻的 nowFn（用于测试高峰系数，不受宿主时区影响）。 */
function fixedNowFn(utcHour) {
  // 2025-01-01 是固定日期；小时由参数控制
  return function () { return new Date(Date.UTC(2025, 0, 1, utcHour, 0, 0)); };
}

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'exec-glm-test-'));
}
function cleanupTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

// ─────────────────────────────────────────────
// Section 1: spawn 参数（智谱端点注入 + --model）
// ─────────────────────────────────────────────

test('spawn 注入 ANTHROPIC_BASE_URL 指向智谱端点 + AUTH_TOKEN', async function () {
  var fakeSpawn = makeFakeSpawn({
    stdout: makeClaudeStdout({ wpId: 'WP-1', passed: true, summary: { total: 1, passed: 1, failed: 0 } }),
  });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(),
    apiKey: 'test-zhipu-key',
  });
  await exec.run(makePending('WP-1'));

  assert.strictEqual(fakeSpawn.calls.length, 1);
  var env = fakeSpawn.calls[0].opts.env;
  assert.strictEqual(env.ANTHROPIC_BASE_URL, 'https://open.bigmodel.cn/api/anthropic');
  assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, 'test-zhipu-key');
});

test('spawn args 含 --model <glm-model>', async function () {
  var fakeSpawn = makeFakeSpawn({
    stdout: makeClaudeStdout({ wpId: 'WP-1', passed: true, summary: { total: 1, passed: 1, failed: 0 } }),
  });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(),
    apiKey: 'k', model: 'glm-5.2',
  });
  await exec.run(makePending('WP-1'));

  var args = fakeSpawn.calls[0].args;
  var mIdx = args.indexOf('--model');
  assert.ok(mIdx !== -1, '应含 --model');
  assert.strictEqual(args[mIdx + 1], 'glm-5.2');
  // 仍含 -p / --output-format json（复用 claude 参数骨架）
  assert.ok(args.indexOf('-p') !== -1);
  var ofIdx = args.indexOf('--output-format');
  assert.ok(ofIdx !== -1 && args[ofIdx + 1] === 'json');
});

test('prompt 复用 claude 模板（含 wpId / json:machine-readable 要求）', async function () {
  var fakeSpawn = makeFakeSpawn({
    stdout: makeClaudeStdout({ wpId: 'WP-5', passed: true, summary: { total: 1, passed: 1, failed: 0 } }),
  });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(), apiKey: 'k',
  });
  await exec.run(makePending('WP-5'));

  // S1：prompt 经 stdin 传入
  var promptArg = fakeSpawn.lastChild._stdinBuf;
  assert.ok(promptArg.indexOf('WP-5') !== -1);
  assert.ok(promptArg.indexOf('json:machine-readable') !== -1);
});

test('retry 模式 prompt 注入 failingDrivers（复用 claude 模板）', async function () {
  var fakeSpawn = makeFakeSpawn({
    stdout: makeClaudeStdout({ wpId: 'WP-3', passed: true, summary: { total: 1, passed: 1, failed: 0 } }),
  });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(), apiKey: 'k',
  });
  var pending = makePending('WP-3', 'retry', {
    failingDrivers: [{ wpId: 'WP-3', category: '测试', item: '边界', reason: '缺 X' }],
  });
  await exec.run(pending);
  var promptArg = fakeSpawn.lastChild._stdinBuf;
  assert.ok(promptArg.indexOf('边界') !== -1);
  assert.ok(promptArg.indexOf('缺 X') !== -1);
});

// ─────────────────────────────────────────────
// Section 2: 额度感知（5h 窗口降速）
// ─────────────────────────────────────────────

test('窗口达软阈值 → quota_exhausted（不 spawn）', async function () {
  var fakeSpawn = makeFakeSpawn({
    stdout: makeClaudeStdout({ wpId: 'WP-1', passed: true, summary: { total: 1, passed: 1, failed: 0 } }),
  });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(), apiKey: 'k',
    quotaWindowPrompts: 10, // 软阈值 0.9 → 9 即触发
    quotaWeeklyPrompts: 1000, // 周限额放开，只测窗口
  });
  // 先用掉 9 个额度（每次 glm-4.6 系数 1x），第 10 次（窗口内已 9，ratio=0.9）触发降速
  for (var i = 0; i < 9; i++) {
    await exec.run(makePending('WP-' + i));
  }
  assert.strictEqual(fakeSpawn.calls.length, 9);
  var blocked = await exec.run(makePending('WP-block'));
  assert.strictEqual(fakeSpawn.calls.length, 9, '第 10 次不应再 spawn');
  assert.strictEqual(blocked.passed, false);
  assert.ok(blocked.failedItems.some(function (fi) { return fi.reason.indexOf('quota_exhausted') !== -1; }));
});

test('周限额达软阈值 → 同样降速（取窗口/周较紧者）', async function () {
  var fakeSpawn = makeFakeSpawn({
    stdout: makeClaudeStdout({ wpId: 'WP-1', passed: true, summary: { total: 1, passed: 1, failed: 0 } }),
  });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(), apiKey: 'k',
    quotaWindowPrompts: 1000,
    quotaWeeklyPrompts: 10, // 周限额先触顶
  });
  for (var i = 0; i < 9; i++) {
    await exec.run(makePending('WP-' + i));
  }
  var blocked = await exec.run(makePending('WP-block'));
  assert.strictEqual(blocked.passed, false);
  assert.ok(blocked.failedItems.some(function (fi) { return fi.reason === 'quota_exhausted'; }));
});

test('缺 API key → quota_exhausted: missing ZHIPU_API_KEY', async function () {
  // 临时清掉环境变量确保 resolveApiKey 返回空
  var saved = { a: process.env.ZHIPU_API_KEY, b: process.env.GLM_API_KEY, c: process.env.ANTHROPIC_AUTH_TOKEN };
  delete process.env.ZHIPU_API_KEY;
  delete process.env.GLM_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    var fakeSpawn = makeFakeSpawn({ stdout: '{}' });
    var exec = createExecutor({ spawnFn: fakeSpawn, projectRoot: process.cwd() });
    var result = await exec.run(makePending('WP-nokey'));
    assert.strictEqual(fakeSpawn.calls.length, 0, '缺 key 不应 spawn');
    assert.strictEqual(result.passed, false);
    assert.ok(result.failedItems[0].reason.indexOf('missing') !== -1);
  } finally {
    if (saved.a) process.env.ZHIPU_API_KEY = saved.a;
    if (saved.b) process.env.GLM_API_KEY = saved.b;
    if (saved.c) process.env.ANTHROPIC_AUTH_TOKEN = saved.c;
  }
});

test('S2 回归：仅设 ANTHROPIC_AUTH_TOKEN 也不回退为 GLM key', async function () {
  // 真实 Anthropic 凭据绝不能被 GLM executor 拾取并发往智谱端点
  var saved = { a: process.env.ZHIPU_API_KEY, b: process.env.GLM_API_KEY, c: process.env.ANTHROPIC_AUTH_TOKEN };
  delete process.env.ZHIPU_API_KEY;
  delete process.env.GLM_API_KEY;
  process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-SECRET-REAL-KEY';
  try {
    // 1) resolveApiKey 直接断言：不再回退 ANTHROPIC_AUTH_TOKEN
    assert.strictEqual(executorGlm._resolveApiKey(), '', 'resolveApiKey 不应回退 ANTHROPIC_AUTH_TOKEN');
    // 2) run() 路径：缺智谱 key → 不 spawn，返回 quota_exhausted
    var fakeSpawn = makeFakeSpawn({ stdout: '{}' });
    var exec = createExecutor({ spawnFn: fakeSpawn, projectRoot: process.cwd() });
    var result = await exec.run(makePending('WP-s2'));
    assert.strictEqual(fakeSpawn.calls.length, 0, '不应 spawn（凭据不应被发往智谱）');
    assert.strictEqual(result.passed, false);
    assert.ok(result.failedItems[0].reason.indexOf('missing') !== -1, '应为 missing key');
  } finally {
    if (saved.a) process.env.ZHIPU_API_KEY = saved.a; else delete process.env.ZHIPU_API_KEY;
    if (saved.b) process.env.GLM_API_KEY = saved.b; else delete process.env.GLM_API_KEY;
    if (saved.c) process.env.ANTHROPIC_AUTH_TOKEN = saved.c; else delete process.env.ANTHROPIC_AUTH_TOKEN;
  }
});

// ─────────────────────────────────────────────
// Section 3: 高峰系数
// ─────────────────────────────────────────────

test('quotaCostFactor：GLM-4.6（非 5.x）恒 1x', function () {
  assert.strictEqual(executorGlm._quotaCostFactor('glm-4.6', fixedNowFn(7)), 1);
  assert.strictEqual(executorGlm._quotaCostFactor('glm-4.6', fixedNowFn(15)), 1); // 高峰也不加成
});

test('quotaCostFactor：GLM-5.2 高峰(UTC7点=北京15点) 3x，非高峰 2x', function () {
  // UTC 7:00 = UTC+8 15:00（高峰 14-18 内）
  assert.strictEqual(executorGlm._quotaCostFactor('glm-5.2', fixedNowFn(7)), 3);
  // UTC 0:00 = UTC+8 8:00（非高峰）
  assert.strictEqual(executorGlm._quotaCostFactor('glm-5.2', fixedNowFn(0)), 2);
  assert.strictEqual(executorGlm._quotaCostFactor('glm-5-turbo', fixedNowFn(7)), 3);
});

// WP-191-4-impl 项 1：正则收紧回归——glm-50/glm-500/glm-4.6 不误命中，GLM5Turbo/glm_5 命中
test('quotaCostFactor 正则收紧：glm-50/glm-500 不误命中 5.x 高峰系数', function () {
  // glm-50 / glm-500：5 后跟数字，不应被识别为 5.x 系列
  assert.strictEqual(executorGlm._quotaCostFactor('glm-50', fixedNowFn(7)), 1);
  assert.strictEqual(executorGlm._quotaCostFactor('glm-500', fixedNowFn(7)), 1);
  // glm-4.6 仍 1x（非 5.x）
  assert.strictEqual(executorGlm._quotaCostFactor('glm-4.6', fixedNowFn(7)), 1);
  // glm-5（5 后字符串尾）仍命中高峰系数
  assert.strictEqual(executorGlm._quotaCostFactor('glm-5', fixedNowFn(7)), 3);
  // GLM5Turbo（无分隔符 + 5 后跟字母，变体支持）
  assert.strictEqual(executorGlm._quotaCostFactor('GLM5Turbo', fixedNowFn(7)), 3);
  // glm_5（下划线分隔）
  assert.strictEqual(executorGlm._quotaCostFactor('glm_5', fixedNowFn(7)), 3);
});

test('isPeakHour：14:00-18:00 UTC+8', function () {
  // UTC 6:00 = 北京 14:00（高峰起）
  assert.strictEqual(executorGlm._isPeakHour(fixedNowFn(6)), true);
  // UTC 9:59 = 北京 17:59（高峰内）
  assert.strictEqual(executorGlm._isPeakHour(function () { return new Date(Date.UTC(2025, 0, 1, 9, 59)); }), true);
  // UTC 10:00 = 北京 18:00（高峰结束，不含）
  assert.strictEqual(executorGlm._isPeakHour(fixedNowFn(10)), false);
  // UTC 0:00 = 北京 8:00（非高峰）
  assert.strictEqual(executorGlm._isPeakHour(fixedNowFn(0)), false);
});

test('额度窗口按高峰系数加权：GLM-5.2 高峰调用消耗 3', async function () {
  var fakeSpawn = makeFakeSpawn({
    stdout: makeClaudeStdout({ wpId: 'WP-1', passed: true, summary: { total: 1, passed: 1, failed: 0 } }),
  });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(), apiKey: 'k',
    model: 'glm-5.2',
    nowFn: fixedNowFn(7), // 北京 15:00 高峰
    quotaWindowPrompts: 30, // 软阈值 0.9 = 27
    quotaWeeklyPrompts: 1000,
  });
  // 一次调用消耗 3，9 次后窗口=27=0.9 → 第 10 次降速
  for (var i = 0; i < 9; i++) {
    await exec.run(makePending('WP-' + i));
  }
  assert.strictEqual(exec.quota.windowUsed(), 27);
  var blocked = await exec.run(makePending('WP-block'));
  assert.strictEqual(blocked.passed, false);
  assert.ok(blocked.failedItems.some(function (fi) { return fi.reason === 'quota_exhausted'; }));
});

// ─────────────────────────────────────────────
// Section 4: stdout 解析（复用 claude 解析）
// ─────────────────────────────────────────────

test('stdout 解析为 passed CheckResult', async function () {
  var chk = {
    wpId: 'WP-7', passed: true,
    summary: { total: 4, passed: 4, failed: 0 },
    categories: [{ name: '代码质量', passed: true, items: [{ id: 'c-1', text: '规范', passed: true }] }],
    failedItems: [],
  };
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout(chk) });
  var exec = createExecutor({ spawnFn: fakeSpawn, projectRoot: process.cwd(), apiKey: 'k' });
  var result = await exec.run(makePending('WP-7'));
  assert.strictEqual(result.wpId, 'WP-7');
  assert.strictEqual(result.passed, true);
  assert.strictEqual(result.summary.total, 4);
});

test('stdout 无 block → 降级 passed:false', async function () {
  var fakeSpawn = makeFakeSpawn({
    stdout: JSON.stringify({ type: 'result', result: '完成但没判定块' }),
  });
  var exec = createExecutor({ spawnFn: fakeSpawn, projectRoot: process.cwd(), apiKey: 'k' });
  var result = await exec.run(makePending('WP-9'));
  assert.strictEqual(result.passed, false);
  assert.ok(result.failedItems.some(function (fi) { return fi.reason.indexOf('machine-readable') !== -1; }));
});

test('wpId 兜底：解析出的 chk 无 wpId 时用 pendingAction.wpId', async function () {
  var chk = { passed: true, summary: { total: 1, passed: 1, failed: 0 } };
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout(chk) });
  var exec = createExecutor({ spawnFn: fakeSpawn, projectRoot: process.cwd(), apiKey: 'k' });
  var result = await exec.run(makePending('WP-fallback'));
  assert.strictEqual(result.wpId, 'WP-fallback');
});

// ─────────────────────────────────────────────
// Section 5: 超时 / spawn 失败 / 非0退出
// ─────────────────────────────────────────────

test('timeoutMs 触发 kill → passed:false + timeout', async function () {
  var fakeSpawn = makeFakeSpawn({ delayMs: 200, stdout: 'late' });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(), apiKey: 'k', timeoutMs: 30,
  });
  var result = await exec.run(makePending('WP-slow'));
  assert.strictEqual(result.passed, false);
  assert.ok(result.failedItems.some(function (fi) { return fi.reason === 'timeout'; }));
});

// WP-192-3 ①：超时路径（SIGTERM/SIGKILL 杀，close code===null）仍需计额度——
// 超时请求在超时窗口内已真实打到智谱端点，消耗套餐额度。
// 构造一个 emit close code=null 的 fake spawn，模拟信号终止的真实 close 事件。
test('超时被信号杀（close code===null）仍扣额度（WP-192-3 ①）', async function () {
  var calls = [];
  var fakeSpawn = function (binary, args, spOpts) {
    calls.push({ binary: binary, args: args, opts: spOpts });
    var child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child._stdinBuf = '';
    child.stdin = {
      write: function (d) { child._stdinBuf += String(d); return true; },
      end: function () {},
      on: function () { return this; },
      once: function () { return this; },
    };
    child.kill = function (_sig) {}; // 模拟 kill 成功，executor 不报错
    // 子进程长时间不退出，等 executor 的 timeout 定时器 kill 它后，
    // 我们手动 emit close code=null（真实信号终止的语义）
    setTimeout(function () {
      child.emit('close', null); // code===null = 被信号杀
    }, 100);
    return child;
  };
  fakeSpawn.calls = calls;

  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(), apiKey: 'k',
    model: 'glm-4.6', // 系数 1x
    timeoutMs: 20, // 很快超时
    quotaWindowPrompts: 10, quotaWeeklyPrompts: 1000,
  });
  var before = exec.quota.windowUsed();
  var result = await exec.run(makePending('WP-timeout-quota'));
  assert.strictEqual(result.passed, false, '超时应返回失败');
  assert.ok(result.failedItems.some(function (fi) { return fi.reason === 'timeout'; }));
  assert.strictEqual(exec.quota.windowUsed(), before + 1, '超时路径应扣额度（glm-4.6 系数 1x）');
});

// 补充：超时 + code=0（fake 默认行为）也计入额度，确保 (code!=null || timedOut) 两条都覆盖
test('超时（fake emit code=0）仍扣额度（WP-192-3 ① 补充）', async function () {
  var fakeSpawn = makeFakeSpawn({ delayMs: 200, stdout: 'late' });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(), apiKey: 'k',
    model: 'glm-4.6', timeoutMs: 30,
    quotaWindowPrompts: 10, quotaWeeklyPrompts: 1000,
  });
  var before = exec.quota.windowUsed();
  await exec.run(makePending('WP-timeout-code0'));
  assert.strictEqual(exec.quota.windowUsed(), before + 1, '超时 code=0 应扣额度');
});

test('spawn 立即抛 ENOENT → passed:false + spawn_failed', async function () {
  var fakeSpawn = makeFakeSpawn({
    spawnError: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }),
  });
  var exec = createExecutor({ spawnFn: fakeSpawn, projectRoot: process.cwd(), apiKey: 'k' });
  var result = await exec.run(makePending('WP-noexe'));
  assert.strictEqual(result.passed, false);
  assert.ok(result.failedItems[0].reason.indexOf('spawn_failed') !== -1);
});

test('子进程 error 事件 → passed:false + spawn_error', async function () {
  var fakeSpawn = makeFakeSpawn({ emitError: true });
  var exec = createExecutor({ spawnFn: fakeSpawn, projectRoot: process.cwd(), apiKey: 'k' });
  var result = await exec.run(makePending('WP-err'));
  assert.strictEqual(result.passed, false);
  assert.ok(result.failedItems[0].reason.indexOf('spawn_error') !== -1);
});

// WP-191-4-impl 项 3：spawn_error 路径不计额度（本地未真打到智谱端点）
test('spawn_error 路径不扣额度（quota 不增长）', async function () {
  var fakeSpawn = makeFakeSpawn({ emitError: true });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(), apiKey: 'k',
    quotaWindowPrompts: 10, quotaWeeklyPrompts: 1000,
  });
  var before = exec.quota.windowUsed();
  await exec.run(makePending('WP-spawnerr'));
  assert.strictEqual(exec.quota.windowUsed(), before, 'spawn_error 不应扣额度');
});

test('spawn 立即抛错（ENOENT）不扣额度', async function () {
  var fakeSpawn = makeFakeSpawn({
    spawnError: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }),
  });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(), apiKey: 'k',
    quotaWindowPrompts: 10, quotaWeeklyPrompts: 1000,
  });
  var before = exec.quota.windowUsed();
  await exec.run(makePending('WP-enoent'));
  assert.strictEqual(exec.quota.windowUsed(), before, 'spawn 立即失败不应扣额度');
});

test('close 且 code != null（真正运行过）正常扣额度', async function () {
  var fakeSpawn = makeFakeSpawn({
    stdout: makeClaudeStdout({ wpId: 'WP-1', passed: true, summary: { total: 1, passed: 1, failed: 0 } }),
    exitCode: 0,
  });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(), apiKey: 'k', model: 'glm-4.6',
  });
  await exec.run(makePending('WP-ok'));
  // glm-4.6 系数 1x → 扣 1
  assert.strictEqual(exec.quota.windowUsed(), 1, '正常退出应扣额度');
});

test('非 0 退出码且无解析结果 → passed:false + claude_exit_<code>', async function () {
  var fakeSpawn = makeFakeSpawn({ stdout: 'garbage', stderr: 'auth failed', exitCode: 1 });
  var exec = createExecutor({ spawnFn: fakeSpawn, projectRoot: process.cwd(), apiKey: 'bad' });
  var result = await exec.run(makePending('WP-fail'));
  assert.strictEqual(result.passed, false);
  assert.ok(result.failedItems[0].reason.indexOf('claude_exit_1') !== -1);
});

// ─────────────────────────────────────────────
// Section 6: 进展检测（WP-191-2-impl，复用 claude 工作树脏度语义）
// ─────────────────────────────────────────────

// 注入式 gitStatusFn：控制工作树脏/干净，避免依赖真实 git 状态
function makeGitStatus(dirty) {
  return function (_args, _opts) {
    return dirty ? ' M src/foo.js\n' : '';
  };
}

test('passed=false 且工作树干净 → noProgress=true（glm 复用 claude 语义，零漂移）', async function () {
  var chk = {
    wpId: 'WP-stuck', passed: false,
    summary: { total: 1, passed: 0, failed: 1 },
    categories: [], failedItems: [{ category: '测试', id: 't-1', reason: 'r' }],
  };
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout(chk) });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(), apiKey: 'k',
    gitStatusFn: makeGitStatus(false),
  });
  var result = await exec.run(makePending('WP-stuck'));
  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.noProgress, true, '工作树干净+passed=false → 无进展');
  assert.strictEqual(result._noProgress, true, '向后兼容字段同步');
  assert.ok(result.failedItems.some(function (fi) { return fi.category === 'progress'; }));
});

test('passed=false 且工作树脏 → noProgress=false（glm 有代码改动即有进展）', async function () {
  var chk = {
    wpId: 'WP-wip', passed: false,
    summary: { total: 1, passed: 0, failed: 1 },
    categories: [], failedItems: [{ category: '测试', id: 't-1', reason: 'r' }],
  };
  var fakeSpawn = makeFakeSpawn({ stdout: makeClaudeStdout(chk) });
  var exec = createExecutor({
    spawnFn: fakeSpawn, projectRoot: process.cwd(), apiKey: 'k',
    gitStatusFn: makeGitStatus(true),
  });
  var result = await exec.run(makePending('WP-wip'));
  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.noProgress, false, '工作树脏 → 有进展');
  assert.ok(!result.failedItems.some(function (fi) { return fi.category === 'progress'; }));
});

// ─────────────────────────────────────────────
// Section 7: 内部工具
// ─────────────────────────────────────────────

test('_buildGlmArgs：在 claude 骨架 flags 后追加 --model，prompt 走 stdin 不进 argv（S1）', function () {
  var args = executorGlm._buildGlmArgs(['Read', 'Bash'], 'glm-4.6');
  assert.ok(args.indexOf('-p') !== -1);
  var mIdx = args.indexOf('--model');
  assert.ok(mIdx !== -1, '应含 --model');
  assert.strictEqual(args[mIdx + 1], 'glm-4.6');
  // S1：prompt 不再进 argv
  assert.ok(args.indexOf('my prompt') === -1, 'args 不应含 prompt（已改走 stdin）');
  assert.ok(args[args.length - 1] === 'glm-4.6', '--model <value> 为最后两项');
});

test('_buildAnthropicEnv：注入智谱端点 + token', function () {
  var env = executorGlm._buildAnthropicEnv('https://x/api/anthropic', 'key123');
  assert.ok(env);
  assert.strictEqual(env.ANTHROPIC_BASE_URL, 'https://x/api/anthropic');
  assert.strictEqual(env.ANTHROPIC_AUTH_TOKEN, 'key123');
  assert.strictEqual(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
});

test('_buildAnthropicEnv：缺 key 返回 null', function () {
  assert.strictEqual(executorGlm._buildAnthropicEnv('https://x', ''), null);
});

test('_createQuotaTracker：窗口/周消耗与 prune', function () {
  var baseTime = Date.UTC(2025, 0, 1, 0, 0, 0);
  var t = baseTime;
  var nowFn = function () { return new Date(t); };
  var tracker = executorGlm._createQuotaTracker(
    { quotaWindowPrompts: 10, quotaWeeklyPrompts: 20 }, nowFn);
  tracker.record(1);
  tracker.record(3);
  assert.strictEqual(tracker.windowUsed(), 4);
  assert.strictEqual(tracker.weekUsed(), 4);
  // 推进 6h（超出 5h 窗口，但仍在周内）
  t = baseTime + 6 * 3600 * 1000;
  assert.strictEqual(tracker.windowUsed(), 0, '6h 后窗口应已清空');
  assert.strictEqual(tracker.weekUsed(), 4, '周内仍累计');
  assert.strictEqual(tracker.windowRatio(), 0.2, '0/10 vs 4/20 取大 = 0.2');
});

test('createExecutor 返回接口契约 { name, run, config, quota }', function () {
  var exec = createExecutor({ apiKey: 'k', projectRoot: process.cwd() });
  assert.strictEqual(exec.name, 'glm');
  assert.strictEqual(typeof exec.run, 'function');
  assert.ok(exec.config && typeof exec.config === 'object');
  assert.ok(exec.quota && typeof exec.quota.windowRatio === 'function');
});
