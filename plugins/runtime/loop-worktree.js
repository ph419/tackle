/**
 * Loop Worktree — per-WP git worktree 隔离管理器（concurrent-dispatch Step 2）
 *
 * @module loop-worktree
 *
 * 背景（docs/reports/2026-07-01_step2-follow-up-worktree-isolation.md）：
 *   v0.4.0 的 --concurrency=N（N>1）并发批调度存在已知限制：executor.run 内的
 *   readWorktreeDirty 共用单一 config.projectRoot，批内 N 个 spawn 并发改同一工作树，
 *   dirtyBefore/dirtyAfter 互相污染 → noProgress 信号在批模式失真（退化为批级而非 per-WP）。
 *   本模块为每个并发 dispatch 的 WP 创建独立 git worktree，executor.run 在各自 cwd 跑，
 *   使脏度检测 per-WP 准确、互不串扰。
 *
 * 合并策略（用户选定，文档 §5.3 问题1 = 策略 A）：
 *   每 WP 独立分支（tackle/{loopId}/{wpId}）→ 批后逐个 cherry-pick 回主分支。
 *   冲突时 git cherry-pick --abort、记 conflict（交 driver 报失败项，engine retry/resplit 兜底），
 *   不阻断 loop 主流程。
 *
 * 生命周期（driver 调用约定）：
 *   批前：每 WP createWorktreeForWp() → 拿到独立 wtPath
 *   dispatchBatch：executor.run 的 pendingAction.projectRoot = wtPath（per-call override）
 *   批后串行回填：每 WP mergeWorktreeBranch()（含冲突检测）→ removeWorktree()
 *
 * 容错纪律（承袭 WP-191/196）：
 *   - 非 git 仓库 / git 不可用 / wpId 非法 / worktree add 失败 → 降级返回 { degraded:true, wtPath:null }，
 *     driver 不注入 override（executor 退回 config.projectRoot = 批级 noProgress，等同 v0.4.0 行为）
 *   - 任何 git 调用失败绝不抛出阻断 loop；全程 try/catch 降级
 *
 * 可测性（codebase DI-over-mocking 哲学，见 executor-claude / loop-dispatch-batch）：
 *   - git 操作通过注入的 execFn（默认 child_process.execFileSync）执行，测试传 fake 不真跑 git
 *   - 真实 git worktree 端到端单测走临时 repo（test/runtime/test-loop-worktree.js）
 *
 * 路径安全（复用 safe-path）：
 *   - wpId / loopId 经 safePath.validateSafeName 消毒，防路径注入（拼进 .tackle/wt-{loopId}-{wpId}）
 */

'use strict';

var path = require('path');
var fs = require('fs');
var safePath = require('./safe-path');

/**
 * 默认 worktree 落盘根（相对 repoRoot；已被 .gitignore 覆盖）。
 * 落盘到 .tackle/ 子树不入 git diff 视野（.gitignore line 11），符合文档 §5.2 提议。
 */
var DEFAULT_WORKTREES_DIRNAME = '.tackle';

/**
 * worktree 分支名前缀（tackle/{loopId}/{wpId}）。
 * 前缀 `tackle/` 命名空间隔离，避免与用户既有分支冲突。
 */
var BRANCH_PREFIX = 'tackle';

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 同步执行 git 子命令的封装（统一异常归一化）。
 * @param {Function} execFn (cmd, args, opts) => string；注入用，默认 execFileSync
 * @param {string} cwd 工作目录
 * @param {string[]} args git 参数（不含 'git' 前缀）
 * @returns {{ok:true,out:string}|{ok:false,err:Error}}
 */
function git(execFn, cwd, args) {
  try {
    var out = execFn('git', args, {
      cwd: cwd,
      encoding: 'utf8',
      timeout: 10000, // worktree 操作放宽到 10s（add/merge 可能较慢）
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out: String(out || '') };
  } catch (e) {
    return { ok: false, err: e };
  }
}

/**
 * 校验 repoRoot 是否为有效 git 仓库（git rev-parse --show-toplevel）。
 *   仅"非空输出"不够：git 会向上递归找父级 .git，若 repoRoot 恰好落在某个上层 git 仓库内
 *   （如 os.tmpdir() 在用户家目录 git 仓库内），会误判为 git 仓库。故进一步校验解析出的
 *   toplevel 与 repoRoot 指向同一目录（path.normalize 规范化后比较，兼容大小写/分隔符差异）。
 * @param {Function} execFn
 * @param {string} repoRoot
 * @returns {boolean}
 */
function isGitRepo(execFn, repoRoot) {
  var r = git(execFn, repoRoot, ['rev-parse', '--show-toplevel']);
  if (!r.ok) return false;
  var top = r.out.trim();
  if (!top) return false;
  // 规范化比较（Windows 路径大小写/分隔符差异）： realpathSync 解析任意符号链接/大小写
  try {
    return path.relative(path.normalize(fs.realpathSync(top)), path.normalize(fs.realpathSync(repoRoot))) === '';
  } catch (_e) {
    // realpath 失败（如路径含特殊字符）退回字符串比较
    return path.normalize(top) === path.normalize(repoRoot);
  }
}

/**
 * 读取 repoRoot 当前 HEAD 提交 sha（cherry-pick base 用）。
 * @param {Function} execFn
 * @param {string} repoRoot
 * @returns {string|null} sha；失败 null
 */
function readHeadSha(execFn, repoRoot) {
  var r = git(execFn, repoRoot, ['rev-parse', 'HEAD']);
  if (!r.ok) return null;
  var sha = r.out.trim();
  return sha.length > 0 ? sha : null;
}

/**
 * 读取 repoRoot 当前分支名（worktree base 用）。
 * 处于 detached HEAD 时返回 HEAD sha（作为 base 仍有效）。
 * @param {Function} execFn
 * @param {string} repoRoot
 * @returns {string|null}
 */
function readCurrentBranch(execFn, repoRoot) {
  var r = git(execFn, repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!r.ok) return null;
  var branch = r.out.trim();
  if (!branch || branch === 'HEAD') {
    // detached HEAD：用 sha 作 base
    return readHeadSha(execFn, repoRoot);
  }
  return branch;
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 为单个 WP 创建独立 git worktree（策略 A：每 WP 独立分支）。
 *
 * 执行：`git worktree add <wtPath> -b tackle/{loopId}/{wpId} [<baseBranch>]`
 * 落盘：wtPath = path.join(worktreesDir, 'wt-{loopId}-{wpId}')
 *
 * 降级条件（任一 → 返回 {degraded:true, wtPath:null}，driver 不注入 override）：
 *   - repoRoot 非 git 仓库 / git 不可用
 *   - loopId 或 wpId 非法（safe-path 校验失败）
 *   - worktree add 失败（如分支已存在、磁盘满）
 *
 * @param {object} opts
 * @param {string} opts.repoRoot 真实 git 仓库根（loop.js:533 chdir 前解析的 projectRoot）
 * @param {string} opts.loopId loop 标识
 * @param {string} opts.wpId WP 标识
 * @param {string} [opts.baseBranch] worktree 起点；缺省用 repo 当前分支/HEAD
 * @param {string} [opts.worktreesDir] worktree 落盘根；缺省 path.join(repoRoot, '.tackle')
 * @param {Function} [opts.execFn] git 执行函数注入（测试用）；默认 execFileSync
 * @returns {{wtPath:string, branch:string, degraded:false} |
 *           {wtPath:null, branch:null, degraded:true, reason:string}}
 */
function createWorktreeForWp(opts) {
  opts = opts || {};
  var repoRoot = opts.repoRoot;
  var loopId = opts.loopId;
  var wpId = opts.wpId;
  var execFn = typeof opts.execFn === 'function'
    ? opts.execFn
    : function () { var cp = require('child_process'); return cp.execFileSync.apply(cp, arguments); };

  // 参数校验（路径安全：loopId/wpId 拼进文件路径与分支名，必须消毒）
  if (!repoRoot || typeof repoRoot !== 'string') {
    return { wtPath: null, branch: null, degraded: true, reason: 'invalid_repoRoot' };
  }
  var loopIdCheck = safePath.validateSafeName(loopId);
  if (!loopIdCheck.ok) {
    return { wtPath: null, branch: null, degraded: true, reason: 'invalid_loopId:' + loopIdCheck.reason };
  }
  var wpIdCheck = safePath.validateSafeName(wpId);
  if (!wpIdCheck.ok) {
    return { wtPath: null, branch: null, degraded: true, reason: 'invalid_wpId:' + wpIdCheck.reason };
  }

  // 非 git 仓库降级
  if (!isGitRepo(execFn, repoRoot)) {
    return { wtPath: null, branch: null, degraded: true, reason: 'not_a_git_repo' };
  }

  // 解析 base 分支（缺省用当前分支 / detached HEAD 的 sha）
  var baseBranch = opts.baseBranch;
  if (!baseBranch) {
    baseBranch = readCurrentBranch(execFn, repoRoot);
    if (!baseBranch) {
      return { wtPath: null, branch: null, degraded: true, reason: 'cannot_resolve_base' };
    }
  }

  // 落盘路径与分支名
  var worktreesDir = opts.worktreesDir || path.join(repoRoot, DEFAULT_WORKTREES_DIRNAME);
  var wtPath = path.join(worktreesDir, 'wt-' + loopId + '-' + wpId);
  var branch = BRANCH_PREFIX + '/' + loopId + '/' + wpId;

  // 确保 worktreesDir 存在（git worktree add 不自动建父目录到任意深度）
  try {
    if (!fs.existsSync(worktreesDir)) fs.mkdirSync(worktreesDir, { recursive: true });
  } catch (_e) {
    return { wtPath: null, branch: null, degraded: true, reason: 'cannot_mkdir_worktreesDir' };
  }

  // 已存在同名 worktree/分支：先清理残留（幂等，承袭 appendProgressLine 幂等思路）。
  //   顺序关键：必须**先 worktree remove 再 branch -D**——分支若被某 worktree 检出，
  //   git branch -D 会失败（"branch is checked out"）。worktree remove 释放检出后才能删分支。
  // 已存在 wtPath 目录：清理（防上次异常残留）
  try {
    if (fs.existsSync(wtPath)) {
      // 先尝试 git worktree remove（登记表清理 + 释放分支检出），失败再物理删
      git(execFn, repoRoot, ['worktree', 'remove', '--force', wtPath]);
      if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true });
    }
  } catch (_e) { /* best-effort */ }
  // 分支已存在 → -b 会失败；worktree 已 remove 后再删分支（best-effort）
  var existingBranch = git(execFn, repoRoot, ['rev-parse', '--verify', branch]);
  if (existingBranch.ok) {
    git(execFn, repoRoot, ['branch', '-D', branch]); // best-effort，失败由 add 报错兜底
  }

  // 创建 worktree + 分支
  var addArgs = ['worktree', 'add', wtPath, '-b', branch];
  if (baseBranch) addArgs.push(baseBranch);
  var addRes = git(execFn, repoRoot, addArgs);
  if (!addRes.ok) {
    return { wtPath: null, branch: null, degraded: true, reason: 'worktree_add_failed' };
  }

  // 防御性校验：wtPath 确实生成
  if (!fs.existsSync(wtPath)) {
    return { wtPath: null, branch: null, degraded: true, reason: 'wtPath_not_created' };
  }

  return { wtPath: wtPath, branch: branch, degraded: false };
}

/**
 * 把 WP worktree 分支的改动 cherry-pick 回主分支（策略 A 合并）。
 *
 * 在 repoRoot（主工作树）执行：`git cherry-pick <branch>`。
 * 冲突 → `git cherry-pick --abort`，返回 {conflict:true}（driver 记失败项，不阻断 loop）。
 * 分支无新提交（WP 未改代码或未 commit）→ 视为无改动，{merged:false, conflict:false}。
 *
 * 注意：本函数假设 WP 在 worktree 内的改动已 commit 到其分支。
 *   claude 子进程只改工作树不自动 commit；driver 在调用本函数前需先在 wtPath 内
 *   `git add -A && git commit`（见 driver 接线），否则 cherry-pick 无提交可拾取。
 *   若 WP 未 commit，本函数的"无新提交"分支返回 merged:false，driver 据此判 noProgress。
 *
 * @param {object} opts
 * @param {string} opts.repoRoot 真实 git 仓库根（主工作树）
 * @param {string} opts.branch 要合并的 WP 分支（tackle/{loopId}/{wpId}）
 * @param {string} [opts.wpId] 仅日志/诊断用
 * @param {Function} [opts.execFn] git 执行函数注入（测试用）
 * @returns {{merged:boolean, conflict:boolean, degraded:boolean, reason?:string}}
 */
function mergeWorktreeBranch(opts) {
  opts = opts || {};
  var repoRoot = opts.repoRoot;
  var branch = opts.branch;
  var execFn = typeof opts.execFn === 'function'
    ? opts.execFn
    : function () { var cp = require('child_process'); return cp.execFileSync.apply(cp, arguments); };

  if (!repoRoot || typeof repoRoot !== 'string' || !branch || typeof branch !== 'string') {
    return { merged: false, conflict: false, degraded: true, reason: 'invalid_args' };
  }
  if (!isGitRepo(execFn, repoRoot)) {
    return { merged: false, conflict: false, degraded: true, reason: 'not_a_git_repo' };
  }

  // 主工作树须 clean 才能 cherry-pick（git 强制要求）；dirty 则先 stash 保护（best-effort）
  //   注：批内串行回填阶段，主工作树理论 clean（改动在各 worktree），但防御性 stash 兜底。
  var dirtyCheck = git(execFn, repoRoot, ['status', '--porcelain']);
  var stashed = false;
  if (dirtyCheck.ok && dirtyCheck.out.trim().length > 0) {
    var stashRes = git(execFn, repoRoot, ['stash', 'push', '--include-untracked']);
    stashed = stashRes.ok;
  }

  try {
    // 分支是否有新提交（相对 HEAD）：无则跳过 cherry-pick（WP 未改/未 commit）
    var logRes = git(execFn, repoRoot, ['rev-list', '--count', 'HEAD..' + branch]);
    if (logRes.ok) {
      var count = parseInt(logRes.out.trim(), 10);
      if (isNaN(count) || count === 0) {
        // 无新提交：WP 未产出代码改动（与 noProgress 信号一致），不合并
        return { merged: false, conflict: false, degraded: false };
      }
    }
    // 分支不存在（已被删/降级路径）：跳过
    var verifyRes = git(execFn, repoRoot, ['rev-parse', '--verify', branch]);
    if (!verifyRes.ok) {
      return { merged: false, conflict: false, degraded: true, reason: 'branch_not_found' };
    }

    // cherry-pick：冲突时退出码非 0 + stderr 含 conflict 标记
    var pickRes = git(execFn, repoRoot, ['cherry-pick', branch]);
    if (pickRes.ok) {
      return { merged: true, conflict: false, degraded: false };
    }
    // 失败：判定是否冲突（cherry-pick 冲突会留下未完成状态，必须 abort）
    var conflictRes = git(execFn, repoRoot, ['diff', '--name-only', '--diff-filter=U']);
    var isConflict = conflictRes.ok && conflictRes.out.trim().length > 0;
    // 无论是否冲突，cherry-pick 失败都 abort 回到 clean 状态（防遗留 sequencer 状态卡住后续）
    git(execFn, repoRoot, ['cherry-pick', '--abort']); // best-effort
    return {
      merged: false,
      conflict: isConflict,
      degraded: !isConflict, // 非冲突的失败算降级（如锁文件、权限）
      reason: isConflict ? 'merge_conflict' : 'cherry_pick_failed',
    };
  } finally {
    // 还原 stash（仅当之前 stash 过）
    if (stashed) {
      git(execFn, repoRoot, ['stash', 'pop']); // best-effort，pop 冲突由用户后续处理
    }
  }
}

/**
 * 清理 WP worktree + 分支（批后收尾，best-effort）。
 *
 * 执行：`git worktree remove --force <wtPath>` + `git branch -D <branch>`。
 * 全程 try/catch：清理失败绝不阻断 loop（残留 worktree 在 .tackle/ 已 gitignored，
 * 不污染 repo，下次 createWorktreeForWp 的幂等清理会兜底）。
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} [opts.wtPath] worktree 路径（可能 null，降级路径）
 * @param {string} [opts.branch] 分支名（可能 null）
 * @param {Function} [opts.execFn] git 执行函数注入（测试用）
 * @returns {{cleaned:boolean}} 至少一项成功即 cleaned:true
 */
function removeWorktree(opts) {
  opts = opts || {};
  var repoRoot = opts.repoRoot;
  var wtPath = opts.wtPath;
  var branch = opts.branch;
  var execFn = typeof opts.execFn === 'function'
    ? opts.execFn
    : function () { var cp = require('child_process'); return cp.execFileSync.apply(cp, arguments); };

  var cleaned = false;

  if (!repoRoot || typeof repoRoot !== 'string') {
    return { cleaned: false };
  }

  // 1. worktree remove（git 登记表清理）
  if (wtPath && isGitRepo(execFn, repoRoot)) {
    var rmRes = git(execFn, repoRoot, ['worktree', 'remove', '--force', wtPath]);
    if (rmRes.ok) cleaned = true;
  }
  // 1b. worktree remove 失败/降级：物理删 wtPath 目录（防残留）
  if (wtPath) {
    try {
      if (fs.existsSync(wtPath)) fs.rmSync(wtPath, { recursive: true, force: true });
    } catch (_e) { /* best-effort */ }
  }

  // 2. branch -D（分支清理）
  if (branch && isGitRepo(execFn, repoRoot)) {
    var brRes = git(execFn, repoRoot, ['branch', '-D', branch]);
    if (brRes.ok) cleaned = true;
  }

  // 3. git worktree prune（清理已删目录的过期登记，防 git worktree list 累积）
  if (isGitRepo(execFn, repoRoot)) {
    git(execFn, repoRoot, ['worktree', 'prune']); // best-effort
  }

  return { cleaned: cleaned };
}

module.exports = {
  createWorktreeForWp: createWorktreeForWp,
  mergeWorktreeBranch: mergeWorktreeBranch,
  removeWorktree: removeWorktree,
  // 暴露内部工具便于单元测试
  _isGitRepo: isGitRepo,
  _readHeadSha: readHeadSha,
  _readCurrentBranch: readCurrentBranch,
  _DEFAULT_WORKTREES_DIRNAME: DEFAULT_WORKTREES_DIRNAME,
  _BRANCH_PREFIX: BRANCH_PREFIX,
};
