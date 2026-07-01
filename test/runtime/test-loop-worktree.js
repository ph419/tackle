/**
 * test-loop-worktree — per-WP git worktree 隔离管理器单测（concurrent-dispatch Step 2）
 *
 * 一模块一测试（CI 70% 阈值）。用真实临时 git repo（os.tmpdir + mkdtempSync + 真跑 git）
 * 验证 createWorktreeForWp / mergeWorktreeBranch / removeWorktree 的端到端行为，
 * 非 DI-over-mocking——worktree 是 git 子命令编排，fake exec 无法验证真实 git 语义。
 *
 * 覆盖：
 *   - createWorktreeForWp：建 worktree + 分支 / wtPath 存在 / 分支名约定
 *   - mergeWorktreeBranch：有改动→cherry-pick 成功 / 无改动→跳过 / 冲突→conflict+abort
 *   - removeWorktree：清理后 wtPath 消失 / 分支删除 / best-effort 不抛
 *   - 降级：非 git 仓库 / 非法 wpId / 非法 loopId / repoRoot 缺失
 *   - 幂等：残留 wtPath/分支 重新 create 能清理重建
 *   - 端到端：create→改文件→commit→merge→主分支含改动→remove（策略 A 完整链路）
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');
var { execFileSync } = require('child_process');

var worktreeMod = require('../../plugins/runtime/loop-worktree');

// ─────────────────────────────────────────────
// Helpers：真实临时 git repo
// ─────────────────────────────────────────────

/** 真实 git 执行（与 loop-worktree 默认一致，测试透传确保一致口径）。 */
function realExec(cmd, args, opts) {
  return execFileSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts));
}

/** 建一个临时 git repo（含初始 commit），返回 repo 根路径。 */
function makeTempRepo() {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-repo-'));
  realExec('git', ['init', '-q'], { cwd: dir });
  realExec('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  realExec('git', ['config', 'user.name', 'Test'], { cwd: dir });
  // 禁用 autocrlf：本仓无 .gitattributes（仓库根有 * text=auto eol=lf），Windows 默认
  //   core.autocrlf=true 会在 checkout 时 LF→CRLF，致测试字节级断言抖动。设 false 让
  //   worktree checkout 保留原始 LF（与 repo 自身的 .gitattributes 纪律一致）。
  realExec('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
  // .gitignore 忽略 .tackle/（createWorktreeForWp 默认 worktreesDir）：冲突/e2e 测试在
  //   主 repo 跑 `git add -A` 时，已建的 .tackle/wt-* 会被 git 当 embedded git repository
  //   （worktree 内含 .git 指针文件）→ 警告噪声 + 主 repo index 被污染成 gitlink。忽略它
  //   与真实仓库一致（仓库根 .gitignore 已覆盖 .tackle/），让测试字节级断言干净稳定。
  fs.writeFileSync(path.join(dir, '.gitignore'), '.tackle/\n.custom-wt/\n');
  // 初始 commit（空仓库无 HEAD，worktree add 需有 base）
  fs.writeFileSync(path.join(dir, 'README.md'), '# init\n');
  realExec('git', ['add', '-A'], { cwd: dir });
  realExec('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

/** 在某 cwd 内做一次 commit（捕获改动到当前分支）。 */
function commitIn(dir, msg) {
  realExec('git', ['add', '-A'], { cwd: dir });
  realExec('git', ['commit', '-q', '-m', msg || 'change'], { cwd: dir });
}

function cleanupDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

// ─────────────────────────────────────────────
// Section 1: createWorktreeForWp
// ─────────────────────────────────────────────

test.describe('createWorktreeForWp', function () {
  test('建独立 worktree + 分支，wtPath 存在', function () {
    var repo = makeTempRepo();
    try {
      var r = worktreeMod.createWorktreeForWp({
        repoRoot: repo, loopId: 'loop1', wpId: 'WP-1', execFn: realExec,
      });
      assert.strictEqual(r.degraded, false, '不应降级');
      assert.ok(r.wtPath, 'wtPath 非空');
      assert.strictEqual(r.branch, 'tackle/loop1/WP-1', '分支名约定');
      assert.ok(fs.existsSync(r.wtPath), 'wtPath 目录实际生成');
      // worktree 内含初始 commit 的文件（从 base checkout）
      assert.ok(fs.existsSync(path.join(r.wtPath, 'README.md')), 'worktree 含 base 文件');
    } finally { cleanupDir(repo); }
  });

  test('worktreesDir 自定义：落在指定目录', function () {
    var repo = makeTempRepo();
    try {
      var customDir = path.join(repo, '.custom-wt');
      var r = worktreeMod.createWorktreeForWp({
        repoRoot: repo, loopId: 'loop1', wpId: 'WP-2',
        worktreesDir: customDir, execFn: realExec,
      });
      assert.strictEqual(r.degraded, false);
      assert.ok(r.wtPath.indexOf(customDir) === 0, 'wtPath 在自定义目录下');
    } finally { cleanupDir(repo); }
  });

  test('非 git 仓库 → 降级 degraded:true', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-nogit-'));
    try {
      var r = worktreeMod.createWorktreeForWp({
        repoRoot: dir, loopId: 'loop1', wpId: 'WP-1', execFn: realExec,
      });
      assert.strictEqual(r.degraded, true, '非 git 仓库应降级');
      assert.strictEqual(r.wtPath, null);
      assert.strictEqual(r.reason, 'not_a_git_repo');
    } finally { cleanupDir(dir); }
  });

  test('非法 wpId（含路径分隔符）→ 降级 invalid_wpId', function () {
    var repo = makeTempRepo();
    try {
      var r = worktreeMod.createWorktreeForWp({
        repoRoot: repo, loopId: 'loop1', wpId: 'bad/id', execFn: realExec,
      });
      assert.strictEqual(r.degraded, true);
      assert.ok(r.reason.indexOf('invalid_wpId') === 0, 'reason 标识 wpId 非法');
    } finally { cleanupDir(repo); }
  });

  test('非法 loopId → 降级 invalid_loopId', function () {
    var repo = makeTempRepo();
    try {
      var r = worktreeMod.createWorktreeForWp({
        repoRoot: repo, loopId: '../escape', wpId: 'WP-1', execFn: realExec,
      });
      assert.strictEqual(r.degraded, true);
      assert.ok(r.reason.indexOf('invalid_loopId') === 0);
    } finally { cleanupDir(repo); }
  });

  test('repoRoot 缺失 → 降级 invalid_repoRoot', function () {
    var r = worktreeMod.createWorktreeForWp({
      repoRoot: null, loopId: 'loop1', wpId: 'WP-1', execFn: realExec,
    });
    assert.strictEqual(r.degraded, true);
    assert.strictEqual(r.reason, 'invalid_repoRoot');
  });

  test('幂等：残留 wtPath/分支 重新 create 能清理重建', function () {
    var repo = makeTempRepo();
    try {
      var r1 = worktreeMod.createWorktreeForWp({
        repoRoot: repo, loopId: 'loop1', wpId: 'WP-1', execFn: realExec,
      });
      assert.strictEqual(r1.degraded, false);
      // 不清理直接再建同名（模拟上次异常残留）
      var r2 = worktreeMod.createWorktreeForWp({
        repoRoot: repo, loopId: 'loop1', wpId: 'WP-1', execFn: realExec,
      });
      assert.strictEqual(r2.degraded, false, '幂等重建成功');
      assert.ok(fs.existsSync(r2.wtPath));
    } finally { cleanupDir(repo); }
  });
});

// ─────────────────────────────────────────────
// Section 2: mergeWorktreeBranch
// ─────────────────────────────────────────────

test.describe('mergeWorktreeBranch', function () {
  test('有改动 → cherry-pick 成功，主分支含改动', function () {
    var repo = makeTempRepo();
    try {
      var wt = worktreeMod.createWorktreeForWp({
        repoRoot: repo, loopId: 'loop1', wpId: 'WP-1', execFn: realExec,
      });
      // 在 worktree 内改文件 + commit
      fs.writeFileSync(path.join(wt.wtPath, 'new-feature.js'), 'module.exports = 1;\n');
      commitIn(wt.wtPath, 'WP-1 feature');

      var m = worktreeMod.mergeWorktreeBranch({
        repoRoot: repo, branch: wt.branch, wpId: 'WP-1', execFn: realExec,
      });
      assert.strictEqual(m.degraded, false);
      assert.strictEqual(m.merged, true, '应 cherry-pick 成功');
      assert.strictEqual(m.conflict, false);
      // 主分支（repo）应含改动
      assert.ok(fs.existsSync(path.join(repo, 'new-feature.js')), '主分支含 worktree 改动');
    } finally { cleanupDir(repo); }
  });

  test('无新提交（WP 未改/未 commit）→ 跳过，merged:false', function () {
    var repo = makeTempRepo();
    try {
      var wt = worktreeMod.createWorktreeForWp({
        repoRoot: repo, loopId: 'loop1', wpId: 'WP-2', execFn: realExec,
      });
      // worktree 内不改任何东西，不 commit
      var m = worktreeMod.mergeWorktreeBranch({
        repoRoot: repo, branch: wt.branch, wpId: 'WP-2', execFn: realExec,
      });
      assert.strictEqual(m.degraded, false);
      assert.strictEqual(m.merged, false, '无改动不应合并');
      assert.strictEqual(m.conflict, false);
    } finally { cleanupDir(repo); }
  });

  test('冲突 → conflict:true 且 abort（主分支保持干净）', function () {
    var repo = makeTempRepo();
    try {
      // base：README.md = '# init\n'
      var wt = worktreeMod.createWorktreeForWp({
        repoRoot: repo, loopId: 'loop1', wpId: 'WP-3', execFn: realExec,
      });
      // worktree 内改 README.md 第一行为 'WT-CHANGE'
      fs.writeFileSync(path.join(wt.wtPath, 'README.md'), 'WT-CHANGE\n');
      commitIn(wt.wtPath, 'WP-3 conflict seed');

      // 主分支同时改 README.md 第一行为 'MAIN-CHANGE'（制造冲突）
      fs.writeFileSync(path.join(repo, 'README.md'), 'MAIN-CHANGE\n');
      commitIn(repo, 'main divergent');

      var m = worktreeMod.mergeWorktreeBranch({
        repoRoot: repo, branch: wt.branch, wpId: 'WP-3', execFn: realExec,
      });
      assert.strictEqual(m.conflict, true, '应检出冲突');
      assert.strictEqual(m.merged, false);
      // abort 后主分支应无残留冲突状态（README.md 仍是 MAIN-CHANGE）
      assert.strictEqual(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), 'MAIN-CHANGE\n');
    } finally { cleanupDir(repo); }
  });

  test('非 git 仓库 → 降级', function () {
    var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-nogit2-'));
    try {
      var m = worktreeMod.mergeWorktreeBranch({
        repoRoot: dir, branch: 'tackle/x/WP-1', execFn: realExec,
      });
      assert.strictEqual(m.degraded, true);
      assert.strictEqual(m.reason, 'not_a_git_repo');
    } finally { cleanupDir(dir); }
  });

  test('参数非法 → 降级 invalid_args', function () {
    var m = worktreeMod.mergeWorktreeBranch({
      repoRoot: null, branch: 'tackle/x/WP-1', execFn: realExec,
    });
    assert.strictEqual(m.degraded, true);
    assert.strictEqual(m.reason, 'invalid_args');
  });

  test('分支不存在 → 降级 branch_not_found', function () {
    var repo = makeTempRepo();
    try {
      var m = worktreeMod.mergeWorktreeBranch({
        repoRoot: repo, branch: 'tackle/nonexistent/WP-9', execFn: realExec,
      });
      assert.strictEqual(m.degraded, true);
      assert.strictEqual(m.reason, 'branch_not_found');
    } finally { cleanupDir(repo); }
  });
});

// ─────────────────────────────────────────────
// Section 3: removeWorktree
// ─────────────────────────────────────────────

test.describe('removeWorktree', function () {
  test('清理后 wtPath 消失 + 分支删除', function () {
    var repo = makeTempRepo();
    try {
      var wt = worktreeMod.createWorktreeForWp({
        repoRoot: repo, loopId: 'loop1', wpId: 'WP-1', execFn: realExec,
      });
      assert.ok(fs.existsSync(wt.wtPath));
      var r = worktreeMod.removeWorktree({
        repoRoot: repo, wtPath: wt.wtPath, branch: wt.branch, execFn: realExec,
      });
      assert.strictEqual(r.cleaned, true);
      assert.ok(!fs.existsSync(wt.wtPath), 'wtPath 应被清理');
      // 分支应被删（git branch -D）
      var branches = realExec('git', ['branch', '--list'], { cwd: repo });
      assert.ok(branches.indexOf(wt.branch) === -1, '分支应被删除');
    } finally { cleanupDir(repo); }
  });

  test('wtPath/branch 缺失 → 不抛，best-effort', function () {
    var repo = makeTempRepo();
    try {
      // 不应抛错
      var r = worktreeMod.removeWorktree({
        repoRoot: repo, wtPath: null, branch: null, execFn: realExec,
      });
      assert.strictEqual(r.cleaned, false);
    } finally { cleanupDir(repo); }
  });

  test('repoRoot 缺失 → cleaned:false 不抛', function () {
    var r = worktreeMod.removeWorktree({
      repoRoot: null, wtPath: '/tmp/whatever', branch: 'x', execFn: realExec,
    });
    assert.strictEqual(r.cleaned, false);
  });
});

// ─────────────────────────────────────────────
// Section 4: 端到端（策略 A 完整链路）
// ─────────────────────────────────────────────

test.describe('端到端：策略 A 完整链路', function () {
  test('create→改→commit→merge→主分支含改动→remove', function () {
    var repo = makeTempRepo();
    try {
      // 1. create
      var wt = worktreeMod.createWorktreeForWp({
        repoRoot: repo, loopId: 'e2e', wpId: 'WP-100', execFn: realExec,
      });
      assert.strictEqual(wt.degraded, false);

      // 2. 在 worktree 改多个文件（模拟 claude 写代码）
      //   先建子目录再写文件（writeFileSync 不会自动建父目录）
      fs.mkdirSync(path.join(wt.wtPath, 'src'), { recursive: true });
      fs.mkdirSync(path.join(wt.wtPath, 'test'), { recursive: true });
      fs.writeFileSync(path.join(wt.wtPath, 'src/feature.js'),
        'function f() { return 42; }\n');
      fs.writeFileSync(path.join(wt.wtPath, 'test/feature.test.js'),
        'var assert = require("assert");\n');

      // 3. commit（driver 在串行回填里做的 git add -A + commit）
      commitIn(wt.wtPath, 'WP-100 impl');

      // 4. merge 回主分支
      var m = worktreeMod.mergeWorktreeBranch({
        repoRoot: repo, branch: wt.branch, wpId: 'WP-100', execFn: realExec,
      });
      assert.strictEqual(m.merged, true);
      assert.strictEqual(m.conflict, false);

      // 5. 主分支含改动
      assert.ok(fs.existsSync(path.join(repo, 'src/feature.js')), '主分支含 src/feature.js');
      assert.ok(fs.existsSync(path.join(repo, 'test/feature.test.js')), '主分支含测试');

      // 6. remove
      var rm = worktreeMod.removeWorktree({
        repoRoot: repo, wtPath: wt.wtPath, branch: wt.branch, execFn: realExec,
      });
      assert.strictEqual(rm.cleaned, true);
      assert.ok(!fs.existsSync(wt.wtPath));

      // 7. 主分支改动仍在（remove 不影响已 merge 的内容）
      assert.ok(fs.existsSync(path.join(repo, 'src/feature.js')), 'remove 后主分支改动保留');
    } finally { cleanupDir(repo); }
  });

  test('多 WP 并发模拟：各自 worktree 独立，互不串扰', function () {
    var repo = makeTempRepo();
    try {
      // 模拟批内 2 个 WP 各自建 worktree
      var wt1 = worktreeMod.createWorktreeForWp({
        repoRoot: repo, loopId: 'multi', wpId: 'WP-A', execFn: realExec,
      });
      var wt2 = worktreeMod.createWorktreeForWp({
        repoRoot: repo, loopId: 'multi', wpId: 'WP-B', execFn: realExec,
      });
      assert.notStrictEqual(wt1.wtPath, wt2.wtPath, '两 WP worktree 路径不同');

      // 各自改不同文件（无冲突）
      fs.writeFileSync(path.join(wt1.wtPath, 'a.js'), 'a;\n');
      fs.writeFileSync(path.join(wt2.wtPath, 'b.js'), 'b;\n');
      commitIn(wt1.wtPath, 'WP-A');
      commitIn(wt2.wtPath, 'WP-B');

      // 串行 merge（driver 单线程回填顺序）
      var m1 = worktreeMod.mergeWorktreeBranch({
        repoRoot: repo, branch: wt1.branch, wpId: 'WP-A', execFn: realExec,
      });
      var m2 = worktreeMod.mergeWorktreeBranch({
        repoRoot: repo, branch: wt2.branch, wpId: 'WP-B', execFn: realExec,
      });
      assert.strictEqual(m1.merged, true);
      assert.strictEqual(m2.merged, true);
      // 主分支含两 WP 改动（线性叠加，无冲突）
      assert.ok(fs.existsSync(path.join(repo, 'a.js')));
      assert.ok(fs.existsSync(path.join(repo, 'b.js')));

      // 清理
      worktreeMod.removeWorktree({ repoRoot: repo, wtPath: wt1.wtPath, branch: wt1.branch, execFn: realExec });
      worktreeMod.removeWorktree({ repoRoot: repo, wtPath: wt2.wtPath, branch: wt2.branch, execFn: realExec });
    } finally { cleanupDir(repo); }
  });
});

// ─────────────────────────────────────────────
// Section 5: 内部工具（覆盖率）
// ─────────────────────────────────────────────

test.describe('内部工具', function () {
  test('_isGitRepo：git 仓库 true / 普通目录 false', function () {
    var repo = makeTempRepo();
    var plain = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-plain-'));
    try {
      assert.strictEqual(worktreeMod._isGitRepo(realExec, repo), true);
      assert.strictEqual(worktreeMod._isGitRepo(realExec, plain), false);
    } finally { cleanupDir(repo); cleanupDir(plain); }
  });

  test('_readHeadSha：返回非空 sha', function () {
    var repo = makeTempRepo();
    try {
      var sha = worktreeMod._readHeadSha(realExec, repo);
      assert.ok(sha && sha.length > 0, 'HEAD sha 非空');
    } finally { cleanupDir(repo); }
  });

  test('_readCurrentBranch：返回当前分支名', function () {
    var repo = makeTempRepo();
    try {
      var br = worktreeMod._readCurrentBranch(realExec, repo);
      assert.ok(br && br.length > 0, '分支名非空');
    } finally { cleanupDir(repo); }
  });
});
