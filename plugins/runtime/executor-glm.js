/**
 * Executor (glm) — Agentic Loop Act 层 provider 执行单元的智谱 GLM 实现（WP-188-impl）
 *
 * @module executor-glm
 *
 * 职责：实现 driver 期望的 `run(pendingAction) -> CheckResult` 契约的智谱 GLM 实现——
 *   通过 spawn Claude Code CLI（claude binary），把其环境变量指向智谱的 Anthropic 兼容层，
 *   从而用"Claude Code 客户端驱动 GLM 模型"。
 *
 * 为什么走 claude CLI 而非裸 API/SDK（docs/wp/WP-188-research.md §2.2）：
 *   智谱 GLM Coding Plan 套餐额度**仅限官方支持的编码工具**（Claude Code / Cline / OpenCode /
 *   Cherry Studio）内使用。裸调智谱 API/SDK **不享套餐额度**（独立 token 计费），且可能被
 *   识别为"非编程工具滥用"导致订阅停用 / 账号封禁。
 *   走 claude CLI = 用官方客户端 + 订阅人本人使用 = 合规 + 享额度。
 *
 * 与 executor-claude 的关系：
 *   - prompt 模板、checklist 解析、进展检测**完全复用** executor-claude 的内部工具
 *     （直接 require 其 _buildPrompt / _parseCheckResult / _normalizeCheckResult 等）
 *   - 差异仅在：spawn 时注入智谱环境变量 + --model 指定 GLM；额度模型升级为 5h 窗口 + 高峰系数
 *
 * 设计约束（docs/plan/agentic-loop-node-driver-m4m5.md 硬约束 #2 / #3）：
 *   - executor 保持无状态：额度感知走"降速返回"（接近上限返回 passed:false + quota_exhausted，
 *     让 driver 的发散检测兜底），不在 executor 里 sleep 或维护全局额度状态机。
 *     全局跨-loop 额度归 WP-190 coordinator 的额度池。
 *   - provider 解耦点是 executor.run()：driver 不直接 spawn claude/glm，本模块与
 *     executor-claude / executor-local 实现同一份接口契约，可互换（--executor=glm）。
 *
 * CheckResult 契约（与 executor-claude / executor-local 一致）：
 *   {
 *     wpId: string,
 *     passed: boolean,
 *     summary: { total, passed, failed },
 *     categories: [{ name, passed, items:[{id,text,passed,reason?}] }],
 *     failedItems: [{ category, id, reason }]
 *   }
 *
 * 可测性（遵循 codebase DI-over-mocking，见 executor-claude / executor-local）：
 *   - createExecutor({ spawnFn }) 注入 spawn 实现，测试传 fake spawn，不真调 claude。
 *   - createExecutor({ nowFn }) 注入时间函数，测试额度窗口与高峰系数不依赖墙钟。
 */

'use strict';

var { spawn } = require('child_process');

// 复用 executor-claude 的内部工具（prompt 模板 / checklist 解析 / 进展检测 / WP 文档读取）
// —— provider 解耦验证锚点：glm 与 claude 共享同一套 prompt+解析，差异仅在调用目标。
var claudeInternals = require('./executor-claude');
var buildPrompt = claudeInternals._buildPrompt;
var buildClaudeArgs = claudeInternals._buildClaudeArgs;
var extractTextFromClaudeStdout = claudeInternals._extractTextFromClaudeStdout;
var parseCheckResult = claudeInternals._parseCheckResult;
var normalizeCheckResult = claudeInternals._normalizeCheckResult;
var buildFailedChecklist = claudeInternals._buildFailedChecklist;
var readGitHead = claudeInternals._readGitHead;
// WP-191-2-impl：进展检测复用 claude 的工作树脏度判定 + applyProgressDetection
// （glm 与 claude 共享同一套进展检测语义，零漂移；原 readGitHead 保留兼容但不再用于进展检测）
var readWorktreeDirty = claudeInternals._readWorktreeDirty;
var applyProgressDetection = claudeInternals._applyProgressDetection;

// ---------------------------------------------------------------------------
// 默认配置
// ---------------------------------------------------------------------------

var DEFAULTS = {
  binary: 'claude', // 复用 Claude Code CLI（官方支持的编码工具，享智谱套餐额度）
  // 智谱 Anthropic 兼容端点（docs.bigmodel.cn/cn/guide/develop/claude/introduction）
  baseUrl: 'https://open.bigmodel.cn/api/anthropic',
  model: 'glm-4.6', // 默认模型；GLM-5.2/5-Turbo 有 3x 高峰系数，按需 --glm-model 切换
  timeoutMs: 15 * 60 * 1000, // 单次执行超时 15min（对齐 executor-claude/local）
  allowedTools: [
    // 白名单与 executor-claude 一致：允许读写代码与跑测试，禁改 .claude/ 内部状态
    'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash',
  ],
  // 额度模型（docs/wp/WP-188-research.md §3，智谱 GLM Coding Plan）
  // 每 5h 滚动窗口 prompts 上限 + 每周上限，按套餐档位。
  // 默认取 Pro 档（400/5h, 2000/周）作为单实例预算；实际配额由 coordinator 额度池统一管。
  //
  // WP-192-3 ②语义澄清：本配置是**单 executor 实例**预算（一个 loop 一个 executor 实例，
  // 寿命约 maxIters 轮）。quotaTracker 进程内存状态，不跨 loop 共享。
  //   - quotaWindowPrompts：5h 窗口在单实例寿命内可触达，是本实例主要降速依据。
  //   - quotaWeeklyPrompts：周限额在单实例寿命内（数十分钟级）永不满，保留仅为
  //     (a) 向后兼容测试与 quotaTracker.windowRatio 取窗口/周较紧者的语义；
  //     (b) 长生命周期场景（如 loop 复用 executor）的兜底。
  //     跨 loop 的真实周限额由 WP-190 coordinator 额度池统管，executor 不维护全局状态
  //     （硬约束 #2）。勿删除 quotaWeeklyPrompts——会破坏 windowRatio 语义与现有测试。
  quotaWindowPrompts: 400, // 5h 窗口 prompts 软上限（单实例主要降速依据）
  // 注：此值与 loop-server-core.js:67 glm.windowPrompts=400 是同一套餐档位的两处表达
  // （WP-192-3 ③：本批次为避免与 WP-192-4 同文件冲突，保留双处 + 注释交叉引用，
  //   未抽共享常量；若需集中配置请评估后再改，勿在此子包动 loop-server-core.js）
  quotaWeeklyPrompts: 2000, // 周 prompts 软上限（单实例内永不满，跨 loop 由 coordinator 统管）
  // 高峰时段 14:00-18:00 (UTC+8)，GLM-5.2/5-Turbo 按 3x 扣；非高峰 2x。
  // （限时福利非高峰 1x 至 2025-09 底已过，现统一 2x/3x。glm-4.6 等非 5.x 模型按 1x。）
  peakStartUtc8Hour: 14,
  peakEndUtc8Hour: 18,
  // 软上限触发阈值：已用额度达到 quota * threshold 时开始降速
  // （留 10% 余量，避免窗口边界把最后几个 prompt 打爆硬上限）
  quotaSoftThreshold: 0.9,
};

// ---------------------------------------------------------------------------
// 额度感知（docs/wp/WP-188-research.md §3.3）
// ---------------------------------------------------------------------------

/**
 * 判断当前时刻是否落在智谱高峰时段（14:00-18:00 UTC+8）。
 * 用 UTC+8 小时数比较，与宿主时区无关。
 * @param {Function} nowFn 注入的时间函数（测试用），返回 Date
 * @returns {boolean}
 */
function isPeakHour(nowFn) {
  var now = (nowFn || function () { return new Date(); })();
  // getUTCHours + 8 取模 24 = UTC+8 当前小时
  var beijingHour = (now.getUTCHours() + 8) % 24;
  return beijingHour >= DEFAULTS.peakStartUtc8Hour && beijingHour < DEFAULTS.peakEndUtc8Hour;
}

/**
 * 计算一次调用消耗的额度系数（高峰 3x / 非高峰 2x，仅 GLM-5.x 系列；其它模型 1x）。
 * docs/wp/WP-188-research.md §3.3：GLM-5.2 / GLM-5-Turbo 高峰 3 倍、非高峰 2 倍。
 * @param {string} model 模型名
 * @param {Function} nowFn 注入的时间函数（测试用）
 * @returns {number} 系数（1 / 2 / 3）
 */
function quotaCostFactor(model, nowFn) {
  model = model || '';
  // 仅 5.x 系列受高峰系数影响（glm-5.2 / glm-5-turbo / glm-5）。
  // WP-191-4-impl 项 1：正则收紧——原 /glm-?5/i 偏宽，会误匹配 glm-50 / glm-500
  // 等假设性变体（glm 后接 50 仍命中 5）。改为锚定：glm 开头、紧跟可选分隔符、再 5，
  // 且 5 之后不能是数字（用负向断言 (?!\d)）。这样 glm-5.2 / glm-5-turbo / GLM5Turbo /
  // glm_5 命中，而 glm-50 / glm-500 / glm-4.6 不命中。
  var isPeakTier = /^glm[-_]?5(?!\d)/i.test(model);
  if (!isPeakTier) return 1;
  return isPeakHour(nowFn) ? 3 : 2;
}

/**
 * 创建一个 5h 滚动窗口额度计数器。
 * 记录每次调用的 { ts, cost }，提供 usedInWindow / usedInWeek 查询。
 * 进程内存状态（单 loop 一个 executor 实例 = 单进程），不持久化。
 *
 * 硬约束 #2：executor 不维护全局额度状态机，这里的窗口仅用于"本实例是否接近软上限"
 * 的降速判断，不跨 loop 共享。跨 loop 的额度归 WP-190 coordinator。
 *
 * @param {object} config { quotaWindowPrompts, quotaWeeklyPrompts }
 * @param {Function} nowFn 注入的时间函数（测试用）
 * @returns {{ record:Function, windowUsed:Function, weekUsed:Function, windowRatio:Function }}
 */
function createQuotaTracker(config, nowFn) {
  var WINDOW_MS = 5 * 60 * 60 * 1000; // 5h
  var WEEK_MS = 7 * 24 * 60 * 60 * 1000; // 7d
  var entries = []; // { ts:number, cost:number }

  var getNow = function () { return (nowFn || function () { return new Date(); })().getTime(); };

  function prune() {
    var now = getNow();
    // 保留一周内的（周限额需要），窗口查询时再按 5h 过滤
    entries = entries.filter(function (e) { return now - e.ts < WEEK_MS; });
  }

  return {
    /** 记录一次调用消耗。@param {number} cost 系数加权后的消耗（通常为 1/2/3） */
    record: function (cost) {
      prune();
      entries.push({ ts: getNow(), cost: cost });
    },
    /** 近 5h 窗口内已用额度（系数加权） */
    windowUsed: function () {
      var now = getNow();
      var sum = 0;
      for (var i = 0; i < entries.length; i++) {
        if (now - entries[i].ts < WINDOW_MS) sum += entries[i].cost;
      }
      return sum;
    },
    /** 近 7d 已用额度（系数加权） */
    weekUsed: function () {
      var now = getNow();
      var sum = 0;
      for (var i = 0; i < entries.length; i++) {
        if (now - entries[i].ts < WEEK_MS) sum += entries[i].cost;
      }
      return sum;
    },
    /** 窗口已用比例（取窗口/周两者的较大值，反映"最紧的那条限额"） */
    windowRatio: function () {
      var w = config.quotaWindowPrompts > 0
        ? this.windowUsed() / config.quotaWindowPrompts : 0;
      var k = config.quotaWeeklyPrompts > 0
        ? this.weekUsed() / config.quotaWeeklyPrompts : 0;
      return Math.max(w, k);
    },
    /** 测试用：当前记录条数 */
    _size: function () { return entries.length; },
  };
}

// ---------------------------------------------------------------------------
// 环境变量与 spawn 参数构造（glm 特有）
// ---------------------------------------------------------------------------

/**
 * 构造 glm 调用的 claude CLI 参数。
 * 在 executor-claude 的基础上追加 `--model <glm-model>`。
 *
 * SECURITY (S1)：prompt 不在 args 里，统一走 stdin（见 executor-claude.buildClaudeArgs）。
 *
 * @param {string[]} allowedTools
 * @param {string} model GLM 模型名
 * @returns {string[]}
 */
function buildGlmArgs(allowedTools, model) {
  // 复用 claude 的参数构造（-p / --output-format json / --allowedTools）
  var args = buildClaudeArgs(allowedTools);
  // 追加 --model 指定 GLM 模型（prompt 走 stdin，不进 args）
  args.push('--model', model);
  return args;
}

/**
 * 构造 spawn 的环境变量：在父进程 env 基础上注入智谱 Anthropic 兼容端点。
 *
 * WP-192-3 ④命名修正：原名 buildGlmEnv 易误解为"glm 专属"，但本函数构造的是通用的
 * claude CLI anthropic 环境变量（ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN），对任何
 * Anthropic 兼容端点（智谱、月之暗面等）都适用，故改名 buildAnthropicEnv。
 *
 * 关键合规点（docs/wp/WP-188-research.md §2.2）：
 *   把 claude CLI 指向智谱 /api/anthropic 端点，使其驱动 GLM 模型——
 *   这是"用官方编码工具（Claude Code）调智谱"，享套餐额度且合规。
 *
 * @param {string} baseUrl anthropic 兼容端点（如智谱 /api/anthropic）
 * @param {string} apiKey API Key（从环境变量读，不在代码里硬编码）
 * @returns {object|null} 完整 env（含注入项）；缺 key 时返回 null（调用方降速返回）
 */
function buildAnthropicEnv(baseUrl, apiKey) {
  if (!apiKey) return null;
  var env = Object.assign({}, process.env);
  // claude CLI 读 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 决定后端
  env.ANTHROPIC_BASE_URL = baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = apiKey;
  // 禁用 claude CLI 的非必要遥测/自动更新，适配国内网络（与社区集成指南一致）
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
  return env;
}

/**
 * 读取智谱 API Key。仅认 ZHIPU_API_KEY / GLM_API_KEY。
 *
 * SECURITY (S2)：**不**回退 ANTHROPIC_AUTH_TOKEN。否则当用户同时配置了真实
 * Anthropic 凭据时，GLM executor 会静默拾取它，配合 ANTHROPIC_BASE_URL 指向
 * 智谱端点，把真实 Anthropic key 发往智谱（端点被 MITM 即泄漏）。找不到智谱
 * 专用 key 时返回空串，由 run() 降速返回 quota_exhausted。
 *
 * @returns {string}
 */
function resolveApiKey() {
  return process.env.ZHIPU_API_KEY || process.env.GLM_API_KEY || '';
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 创建一个 glm executor 实例。
 *
 * @param {object} [opts]
 * @param {Function} [opts.spawnFn] 注入 spawn（测试用）；默认 child_process.spawn
 * @param {string} [opts.binary] claude 可执行名（默认 'claude'）
 * @param {string} [opts.baseUrl] 智谱 anthropic 兼容端点
 * @param {string} [opts.model] GLM 模型名（默认 glm-4.6）
 * @param {string} [opts.apiKey] 显式传入 API key（测试用；默认从环境变量读）
 * @param {number} [opts.timeoutMs] 单次超时（ms）
 * @param {number} [opts.quotaWindowPrompts] 5h 窗口 prompts 软上限
 * @param {number} [opts.quotaWeeklyPrompts] 周 prompts 软上限
 * @param {number} [opts.quotaSoftThreshold] 降速触发阈值比例（默认 0.9）
 * @param {string[]} [opts.allowedTools] 工具白名单
 * @param {string} [opts.projectRoot] 项目根覆盖（默认自动探测）
 * @param {Function} [opts.nowFn] 注入时间函数（测试用）
 * @returns {{ name:string, run:Function, config:object }}
 */
function createExecutor(opts) {
  opts = opts || {};
  var config = {
    binary: opts.binary || DEFAULTS.binary,
    baseUrl: opts.baseUrl || DEFAULTS.baseUrl,
    model: opts.model || DEFAULTS.model,
    timeoutMs: typeof opts.timeoutMs === 'number' ? opts.timeoutMs : DEFAULTS.timeoutMs,
    allowedTools: (opts.allowedTools && opts.allowedTools.length)
      ? opts.allowedTools.slice() : DEFAULTS.allowedTools.slice(),
    projectRoot: opts.projectRoot || claudeInternals._resolveProjectRoot(),
    quotaWindowPrompts: typeof opts.quotaWindowPrompts === 'number'
      ? opts.quotaWindowPrompts : DEFAULTS.quotaWindowPrompts,
    quotaWeeklyPrompts: typeof opts.quotaWeeklyPrompts === 'number'
      ? opts.quotaWeeklyPrompts : DEFAULTS.quotaWeeklyPrompts,
    quotaSoftThreshold: typeof opts.quotaSoftThreshold === 'number'
      ? opts.quotaSoftThreshold : DEFAULTS.quotaSoftThreshold,
  };
  var apiKey = opts.apiKey !== undefined ? opts.apiKey : resolveApiKey();
  var spawnFn = opts.spawnFn || spawn;
  // WP-191-2-impl：进展检测 git status 注入（测试用；默认走 readWorktreeDirty 内 execFileSync）
  var gitStatusFn = typeof opts.gitStatusFn === 'function' ? opts.gitStatusFn : null;
  var nowFn = opts.nowFn;

  var quota = createQuotaTracker({
    quotaWindowPrompts: config.quotaWindowPrompts,
    quotaWeeklyPrompts: config.quotaWeeklyPrompts,
  }, nowFn);

  /**
   * 执行 pendingAction：spawn claude（指向智谱端点）→ 收集 stdout → 解析 checklist block。
   *
   * 额度感知流程（docs/wp/WP-188-research.md §3.3，硬约束 #2"降速返回"）：
   *   1. 调用前查 quotaRatio，超过软阈值 → 返回 quota_exhausted（不 spawn），让 driver 发散检测兜底
   *   2. 调用后按高峰系数（1x/2x/3x）计入额度窗口
   *
   * @param {object} pendingAction
   * @returns {Promise<object>} CheckResult
   */
  async function run(pendingAction) {
    pendingAction = pendingAction || {};
    var wpId = pendingAction.wpId || 'unknown';

    // 额度前置检查：接近软上限则降速返回（硬约束 #2：不 sleep，交由 driver 发散检测兜底）
    if (quota.windowRatio() >= config.quotaSoftThreshold) {
      return buildFailedChecklist(wpId, 'quota_exhausted');
    }

    // 缺 API key：返回 quota_exhausted（语义上=无可用额度），不 spawn
    if (!apiKey) {
      return buildFailedChecklist(wpId, 'quota_exhausted: missing ZHIPU_API_KEY');
    }

    // 构造环境变量（注入智谱端点）
    var env = buildAnthropicEnv(config.baseUrl, apiKey);

    // 进展检测基线（WP-191-2-impl，复用 executor-claude 的工作树脏度判定）
    var dirtyBefore = readWorktreeDirty(config.projectRoot, gitStatusFn);

    // 构造 prompt（复用 executor-claude 的 buildPrompt，零改动）+ glm args
    var prompt = buildPrompt(pendingAction, config.projectRoot);
    var args = buildGlmArgs(config.allowedTools, config.model);

    // spawn + 超时控制
    var stdoutBuf = '';
    var stderrBuf = '';
    var timedOut = false;
    // WP-191-4-impl 项 3：额度计入闸门。
    //   spawn 立即失败（ENOENT）/ error 事件（spawn_error）/ close 且 code==null（未真运行）
    //   都意味着本地根本没打到智谱端点，不应消耗套餐额度。仅当 close 且 code!=null
    //   （子进程真正启动并退出）才计额度。
    var quotaRecorded = false;
    var child;
    try {
      child = spawnFn(config.binary, args, {
        cwd: config.projectRoot,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: env,
      });
    } catch (e) {
      // spawn 立即失败（如 binary 不存在）
      return buildFailedChecklist(wpId, 'spawn_failed: ' + ((e && e.code) || (e && e.message) || String(e)));
    }

    // prompt 走 stdin（S1，与 executor-claude 一致）
    if (child.stdin) {
      child.stdin.on('error', function (_e) {});
      try {
        child.stdin.write(prompt);
        child.stdin.end();
      } catch (_writeErr) {
        // 同步写失败：忽略，由 close/error 裁决
      }
    }

    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch (_e) {}
        setTimeout(function () {
          try { child.kill('SIGKILL'); } catch (_e2) {}
        }, 2000);
      }, config.timeoutMs);

      if (child.stdout) {
        child.stdout.on('data', function (chunk) {
          if (chunk) stdoutBuf += chunk.toString();
        });
      }
      if (child.stderr) {
        child.stderr.on('data', function (chunk) {
          if (chunk) stderrBuf += chunk.toString();
        });
      }

      child.on('error', function (err) {
        clearTimeout(timer);
        // WP-191-4-impl 项 3：spawn_error 路径不计额度（本地未真打到智谱端点）。
        //   标记已处理，避免后续可能的 close 事件重复计额度。
        quotaRecorded = true;
        resolve(buildFailedChecklist(wpId, 'spawn_error: ' + (err && err.message ? err.message : String(err))));
      });

      child.on('close', function (code) {
        clearTimeout(timer);

        // WP-191-4-impl 项 3：仅当子进程真正运行过才计额度。
        //   - code != null：进程正常退出（含非 0 退出码），一定打到了端点 → 计。
        //   - timedOut && code == null：超时被 SIGTERM/SIGKILL 杀（WP-192-3 ①修正）。
        //     超时请求在超时窗口内已真实打到智谱端点消耗套餐额度，必须计。
        //   - code == null 且 !timedOut：进程未启动/被外部信号杀（未打到端点），不计。
        //   spawn_error 已通过 error 事件标记 quotaRecorded，此处跳过。
        if (!quotaRecorded && (code != null || timedOut)) {
          var cost = quotaCostFactor(config.model, nowFn);
          quota.record(cost);
          quotaRecorded = true;
        }

        if (timedOut) {
          resolve(buildFailedChecklist(wpId, 'timeout'));
          return;
        }
        // 提取 text → 解析 checklist block（复用 executor-claude 解析）
        var text = extractTextFromClaudeStdout(stdoutBuf);
        var raw = parseCheckResult(text);
        var chk = normalizeCheckResult(raw, wpId);

        // 进展检测（WP-191-2-impl，复用 executor-claude.applyProgressDetection，零漂移）
        var dirtyAfter = readWorktreeDirty(config.projectRoot, gitStatusFn);
        applyProgressDetection(chk, dirtyBefore, dirtyAfter);
        // 非 0 退出码且无解析结果 → 失败（claude 可能因端点/鉴权问题非 0 退出）
        if (code !== 0 && !raw) {
          resolve(buildFailedChecklist(wpId, 'claude_exit_' + code + ': ' + stderrBuf.slice(0, 200)));
          return;
        }
        resolve(chk);
      });
    });
  }

  return {
    name: 'glm',
    run: run,
    config: config,
    // 暴露额度状态供 coordinator（WP-190）查询只读视图
    quota: {
      windowUsed: quota.windowUsed,
      weekUsed: quota.weekUsed,
      windowRatio: quota.windowRatio,
    },
  };
}

module.exports = {
  createExecutor: createExecutor,
  // 暴露内部工具便于单元测试
  _buildGlmArgs: buildGlmArgs,
  _buildAnthropicEnv: buildAnthropicEnv,
  _resolveApiKey: resolveApiKey,
  _isPeakHour: isPeakHour,
  _quotaCostFactor: quotaCostFactor,
  _createQuotaTracker: createQuotaTracker,
  _DEFAULTS: DEFAULTS,
};
