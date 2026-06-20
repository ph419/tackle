'use strict';

/**
 * loop-server command — 全局 coordinator 守护进程 CLI（WP-190-impl）
 *
 * @module bin/commands/loop-server
 *
 * 把 loop-server-core（纯逻辑 + 文件 IO）包装为 CLI 子命令：
 *   tackle loop-server start [--state-dir=X] [--interval=N] [--no-circuit]
 *   tackle loop-server stop  [--state-dir=X]                  停止守护进程（跨平台 kill）
 *   tackle loop-server status [--state-dir=X]
 *   tackle loop-server list   [--state-dir=X]   （status 别名）
 *   tackle loop-server abort <loop-id> [--state-dir=X] [--reason=...]
 *
 * stop 实现说明（WP-191-1-impl-c）：
 *   Windows 后台守护进程（detached）收不到 Ctrl+C，必须靠 PID 文件 + taskkill 停。
 *   start 写 PID 文件（{stateDir}/loop-server.pid），stop 读 PID 后：
 *     - Windows：child_process.execSync('taskkill /PID <pid> /F /T')
 *     - Unix：process.kill(pid, 'SIGTERM')
 *   降级（不变量 #4）：PID 文件缺失 / 进程已死（ESRCH）→ 友好提示 + 清残留 PID + exit 0。
 *
 * 职责边界（docs/plan/agentic-loop-node-driver-m4m5.md WP-190，硬约束）：
 *   - 只读聚合各 loop 状态（不写各 loop 的 .claude-state，硬约束 #7）；
 *     熔断只写 directive.json sidecar（单向通道，规避多进程并发写）。
 *   - 复用 loop-server-core 的全部逻辑，本文件仅做参数解析 + 轮询循环 + 输出。
 *   - 回退安全（硬约束 #5）：不开 coordinator 时单 driver 仍独立跑。
 *
 * 合规边界（docs/wp/WP-188-research.md §4）：glm 多 loop 并行仅限"订阅人本人本机 +
 *   claude CLI 客户端"场景，禁止跨机共享 API Key。本守护进程的额度池仅做本机单订阅人
 *   的额度统筹，不涉及多账号。
 */

var path = require('path');
var childProcess = require('child_process');
var core = require('../../plugins/runtime/loop-server-core');
var safePath = require('../../plugins/runtime/safe-path');

var IS_WIN = process.platform === 'win32';

module.exports = {
  name: 'loop-server',
  description: 'Global loop coordinator daemon (aggregate multi-loop view, quota pool, circuit break)',

  /**
   * Execute the loop-server command.
   * @public
   * @param {object} ctx CLI context（bin/context.js createContext 产出）
   */
  execute: async function (ctx) {
    var log = (ctx && typeof ctx.log === 'function') ? ctx.log : function (m) { console.log(m); };
    var argv = (ctx.argv || []).slice();

    var subcommand = argv[0] && argv[0].indexOf('-') !== 0 ? argv[0] : 'status';
    var rest = subcommand === argv[0] ? argv.slice(1) : argv;

    // 解析公共 flag
    var stateDir = '.tackle-state';
    var intervalMs = 5000;
    var noCircuit = false;
    var reason = null;
    var abortLoopId = null;
    for (var i = 0; i < rest.length; i++) {
      var a = rest[i];
      if (a.indexOf('--state-dir=') === 0) stateDir = a.slice('--state-dir='.length);
      else if (a.indexOf('--interval=') === 0) intervalMs = parseInt(a.slice('--interval='.length), 10);
      else if (a === '--no-circuit') noCircuit = true;
      else if (a.indexOf('--reason=') === 0) reason = a.slice('--reason='.length);
      else if (a.indexOf('-') !== 0) abortLoopId = a; // abort 子命令的目标 loopId
    }

    var projectRoot = ctx.targetRoot || process.cwd();
    var absStateDir = path.isAbsolute(stateDir) ? stateDir : path.resolve(projectRoot, stateDir);

    switch (subcommand) {
      case 'start':
        await runDaemon(ctx, log, absStateDir, intervalMs, !noCircuit);
        break;
      case 'stop':
        await runStop(ctx, log, absStateDir);
        break;
      case 'status':
      case 'list':
        await runSnapshot(ctx, log, absStateDir);
        break;
      case 'abort':
        await runAbort(ctx, log, absStateDir, abortLoopId, reason);
        break;
      default:
        log(ctx.colorize('Unknown subcommand: ' + subcommand, 'red'));
        log('Usage: tackle loop-server <start|stop|status|list|abort> [options]');
        log('  start [--state-dir=X] [--interval=N] [--no-circuit]  轮询守护进程');
        log('  stop  [--state-dir=X]                               停止守护进程（跨平台 kill）');
        log('  status [--state-dir=X]                               单次全局快照');
        log('  list                                                 status 别名');
        log('  abort <loop-id> [--state-dir=X] [--reason=...]       下发熔断指令');
        ctx.exit(2);
    }
  },

  // 暴露供测试
  _core: core,
};

// ---------------------------------------------------------------------------
// status / list：单次快照
// ---------------------------------------------------------------------------

async function runSnapshot(ctx, log, stateDir) {
  try {
    var view = await core.aggregateGlobalView(stateDir);
    var pool = core.applyQuotaPool(view);
    log(core.formatGlobalView(view, pool));
    ctx.exit(0);
  } catch (e) {
    log(ctx.colorize('Error: ' + (e && e.message ? e.message : String(e)), 'red'));
    ctx.exit(1);
  }
}

// ---------------------------------------------------------------------------
// abort：下发熔断指令到指定 loop
// ---------------------------------------------------------------------------

async function runAbort(ctx, log, stateDir, loopId, reason) {
  if (!loopId) {
    log(ctx.colorize('Error: abort 需要指定 loop-id', 'red'));
    log('Usage: tackle loop-server abort <loop-id> [--reason=...]');
    ctx.exit(2);
    return;
  }
  // S4：校验 loopId 字符集，防止 writeAbortDirective 用 path.join 逃逸出 stateDir
  var v = safePath.validateSafeName(loopId);
  if (!v.ok) {
    log(ctx.colorize('Error: 非法 loop-id (' + v.reason + '): ' + loopId, 'red'));
    log('仅允许字母/数字/_/-，1-64 字符。');
    ctx.exit(2);
    return;
  }
  try {
    var p = core.writeAbortDirective(stateDir, loopId, reason);
    log(ctx.colorize('✓ 已下发熔断指令', 'green'));
    log('  loopId: ' + loopId);
    log('  directive: ' + p);
    log('  reason: ' + (reason || 'coordinator 全局熔断'));
    log('  (driver 下一轮 step 后将读取并优雅退出)');
    ctx.exit(0);
  } catch (e) {
    log(ctx.colorize('Error: ' + (e && e.message ? e.message : String(e)), 'red'));
    ctx.exit(1);
  }
}

// ---------------------------------------------------------------------------
// stop：跨平台停止守护进程（WP-191-1-impl-c）
// ---------------------------------------------------------------------------

/**
 * 停止守护进程：读 PID 文件 → 跨平台 kill → 清理 PID 文件。
 *
 * 降级（不变量 #4 — stop 失败/守护不存在不阻断主流程）：
 *   - PID 文件不存在（守护未启动）→ 友好提示 + exit 0
 *   - 进程已死（ESRCH）→ 视为已停止，清理残留 PID 文件 + exit 0
 *   - kill 抛其它异常 → 报错但清理 PID 文件 + exit 1
 *
 * 跨平台 kill：
 *   - Windows：taskkill /PID <pid> /F /T（/T 连带子进程；/F 强制）。
 *     用 execSync 同步执行，taskkill 不存在时 execSync 抛错走降级。
 *   - Unix：process.kill(pid, 'SIGTERM')，配合守护进程的 SIGTERM handler 优雅退出。
 *
 * @param {object} ctx
 * @param {Function} log
 * @param {string} stateDir
 */
async function runStop(ctx, log, stateDir) {
  var pidInfo = core.readPidFile(stateDir);
  if (!pidInfo) {
    // 降级：PID 文件缺失视为守护未运行
    log(ctx.colorize('未发现 loop-server 守护进程（无 PID 文件）', 'yellow'));
    log('  state-dir: ' + stateDir);
    ctx.exit(0);
    return;
  }

  var pid = pidInfo.pid;
  try {
    killDaemonPid(pid);
    log(ctx.colorize('✓ 已停止 loop-server 守护进程', 'green'));
    log('  pid: ' + pid);
    log('  state-dir: ' + stateDir);
  } catch (e) {
    var msg = e && e.message ? e.message : String(e);
    // ESRCH（Unix process.kill）/ taskkill 退出码 128（进程不存在）→ 已死，降级成功
    var alreadyDead = isAlreadyDeadError(e);
    if (alreadyDead) {
      log(ctx.colorize('loop-server 守护进程 (pid=' + pid + ') 已不在运行，清理残留 PID 文件', 'yellow'));
    } else {
      log(ctx.colorize('停止守护进程失败 (pid=' + pid + '): ' + msg, 'red'));
    }
  } finally {
    // 无论 kill 成功/降级，都清理 PID 文件（守护若存活，其退出 handler 也会清，幂等）
    core.clearPidFile(stateDir);
  }

  // 已死或成功都 exit 0；非"已死"的真异常已在上面打印，仍 exit 0（降级，不阻断主流程）
  ctx.exit(0);
}

/**
 * 跨平台 kill 守护进程 PID。
 * @param {number} pid
 * @throws 进程不存在（ESRCH / taskkill 报进程不存在）或其它 kill 错误
 */
function killDaemonPid(pid) {
  if (IS_WIN) {
    // /F 强制终止；/T 连带子进程树。taskkill 对不存在的 PID 返回非零退出码（通常 128）。
    childProcess.execSync('taskkill /PID ' + pid + ' /F /T', { stdio: 'ignore' });
  } else {
    process.kill(pid, 'SIGTERM');
  }
}

/**
 * 判断 kill 异常是否表示"进程已不存在"（已死），用于降级为友好提示。
 * @param {Error} e
 * @returns {boolean}
 */
function isAlreadyDeadError(e) {
  if (!e) return false;
  // Unix process.kill 进程不存在抛 ESPIPE? 不：抛系统错误，code 'ESRCH'
  if (e.code === 'ESRCH') return true;
  var msg = e.message || '';
  // Windows taskkill 进程不存在：exit code 128 + message 含 "not found" / "找不到"
  if (/\b(128|ESRCH)\b/.test(msg)) return true;
  if (/not\s+found|no\s+such|不存在|找不到/i.test(msg)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// start：轮询守护进程
// ---------------------------------------------------------------------------

/**
 * 轮询守护：每 intervalMs 聚合一次全局视图，打印 + 执行熔断策略。
 * 熔断策略（docs/plan/agentic-loop-node-driver-m4m5.md WP-190）：
 *   1. 任一 loop circuit_broken/aborted → 对其它仍活跃的 loop 下发 abort（全局回退）
 *   2. 某 provider 额度 ratio 超阈值 → 对该 provider 的活跃 loop 下发 abort（额度兜底）
 *   3. --no-circuit 关闭自动熔断，仅观察（dry-run 守护）
 * Ctrl+C / SIGINT 优雅退出。
 */
async function runDaemon(ctx, log, stateDir, intervalMs, enableCircuit) {
  log(ctx.colorize('=== Loop Coordinator Daemon ===', 'cyan'));
  log('state-dir: ' + stateDir);
  log('interval:  ' + intervalMs + 'ms');
  log('circuit:   ' + (enableCircuit ? 'enabled' : 'disabled (--no-circuit)'));
  log('按 Ctrl+C 退出，或用 `tackle loop-server stop` 跨平台停止');
  log('');

  // 写守护进程 PID 文件（WP-191-1-impl-c：供 stop 子命令跨平台 kill 用）
  var pidFile;
  try {
    pidFile = core.writePidFile(stateDir, process.pid);
    log('pid file: ' + pidFile + ' (pid=' + process.pid + ')');
  } catch (e) {
    // 降级（不变量 #4）：PID 文件写失败不阻断守护启动，仅提示（此时 stop 不可用）
    log(ctx.colorize('warn: 写 PID 文件失败，stop 子命令将不可用: ' +
      (e && e.message ? e.message : String(e)), 'yellow'));
  }

  // 守护退出时清理自身 PID 文件（无论 SIGINT/SIGTERM/异常退出路径都应清理，幂等）
  var cleanupPid = function () {
    core.clearPidFile(stateDir);
  };

  var running = true;
  var onExit = function () {
    running = false;
  };
  process.on('SIGINT', onExit);
  process.on('SIGTERM', onExit);
  process.on('exit', cleanupPid);

  // 首次立即跑一轮
  await tick();
  if (!running) {
    log(ctx.colorize('coordinator 已停止', 'yellow'));
    process.removeListener('SIGINT', onExit);
    process.removeListener('SIGTERM', onExit);
    process.removeListener('exit', cleanupPid);
    cleanupPid();
    ctx.exit(0);
    return;
  }

  var timer = setInterval(function () {
    tick().catch(function (e) {
      log(ctx.colorize('tick error: ' + (e && e.message ? e.message : String(e)), 'red'));
    });
  }, intervalMs);
  // setInterval 不阻止进程退出，但守护进程靠它保持存活；SIGINT 时 clear + exit

  // 轮询保活：检测 running=false 后清理退出
  var watchdog = setInterval(function () {
    if (!running) {
      clearInterval(timer);
      clearInterval(watchdog);
      log(ctx.colorize('coordinator 已停止', 'yellow'));
      process.removeListener('SIGINT', onExit);
      process.removeListener('SIGTERM', onExit);
      process.removeListener('exit', cleanupPid);
      cleanupPid();
      ctx.exit(0);
    }
  }, 500);

  async function tick() {
    var view, pool;
    try {
      view = await core.aggregateGlobalView(stateDir);
      pool = core.applyQuotaPool(view);
    } catch (e) {
      log(ctx.colorize('聚合失败: ' + (e && e.message ? e.message : String(e)), 'red'));
      return;
    }
    var stamp = new Date().toISOString().slice(11, 19);
    var g = view.global || {};
    log('[' + stamp + '] ' + (g.verdict || '?') +
      ' | loops=' + (view.total_loops || 0) +
      ' (achieved=' + g.achievedCount + ' running=' + g.runningCount +
      ' circuit=' + g.circuitCount + ' failed=' + g.failedCount + ' dc=' + g.disconnectedCount + ')');

    if (!enableCircuit) return;

    // 熔断策略 1：全局回退（任一 circuit_broken → 其它活跃 loop 也熔断）
    var circuitTargets = core.selectLoopsForGlobalCircuitBreak(view);
    for (var i = 0; i < circuitTargets.length; i++) {
      core.writeAbortDirective(stateDir, circuitTargets[i], 'global_circuit_break: 伴生 loop 熔断');
      log(ctx.colorize('  ⚠ 全局回退：对 ' + circuitTargets[i] + ' 下发熔断', 'yellow'));
    }

    // 熔断策略 2：额度兜底（provider 超阈值 → 该 provider 活跃 loop 熔断）
    var quotaTargets = core.selectLoopsForQuotaExhaustion(view, pool);
    for (var j = 0; j < quotaTargets.length; j++) {
      var lid = quotaTargets[j];
      var provider = (view.providers && view.providers[lid]) || '?';
      core.writeAbortDirective(stateDir, lid, 'quota_exhausted: provider ' + provider + ' 额度触顶');
      log(ctx.colorize('  ⚠ 额度兜底：对 ' + lid + ' (' + provider + ') 下发熔断', 'yellow'));
    }

    // WP-191-1-impl-b：清理已消费的熔断指令。对已终态的 loop 兜底删除残留 directive.json
    //   （driver 端 applyDirective 成功后已自行删除，本步兜底 driver crash/kill -9 来不及
    //   删除的残留 + 防 `--loop-id` 恢复时二次熔断）。只清终态 loop，不影响活跃 loop 待消费指令。
    var cleaned = core.cleanupConsumedDirectives(stateDir, view);
    for (var k = 0; k < cleaned.length; k++) {
      log(ctx.colorize('  · 清理终态 loop 残留熔断指令: ' + cleaned[k], 'gray'));
    }
  }
}
