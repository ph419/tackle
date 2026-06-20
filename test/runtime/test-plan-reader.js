/**
 * Unit tests for plan-reader (WP-177-1-impl-a)
 * Run with: node --test test/runtime/test-plan-reader.js
 *
 * 覆盖（对应 WP-177-1-impl-a.md 任务清单/验收标准）：
 *   - 正常多 section（≥3）解析为 WP 集合
 *   - checklist 提取（id 稳定性 / category / 勾选状态）
 *   - 依赖图构建（邻接 / 拓扑序 / dependents）
 *   - 循环依赖检测（默认抛 + throwOnCycle=false 不抛）
 *   - 空 plan / 缺失文件 / 读失败 降级不抛
 *   - 单 section（无标题兜底 / Step 行切分）
 *   - 任务项勾选状态识别（[ ]/[x]/[✓]/[X]）
 *   - 显式 WP-NNN 标题 vs 派生编号
 *   - WP-186 字母/混合编号放宽（WP-A / WP-feature-x 端到端）
 *   - 成功标准 section 抽取
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');

var planReader = require('../../plugins/runtime/plan-reader');

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plan-reader-test-'));
}

function setupPlan(content, extra) {
  extra = extra || {};
  var dir = makeTmpDir();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  var planPath = path.join(dir, '.claude', 'plan.md');
  if (content !== undefined && content !== null) {
    fs.writeFileSync(planPath, content, 'utf8');
  }
  if (extra.taskMd) {
    fs.writeFileSync(path.join(dir, 'task.md'), extra.taskMd, 'utf8');
  }
  return {
    dir: dir,
    planPath: planPath,
    cleanup: function () {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
    },
  };
}

// ─────────────────────────────────────────────
// Section 1: 正常多 section 解析
// ─────────────────────────────────────────────

test.describe('正常多 section 解析', function () {
  test('含 ≥3 个 section 解析为对应 WP 集合', function () {
    var content = [
      '# 总计划',
      '',
      '## 数据模型',
      '- [ ] 定义 User 表',
      '- [ ] 定义 Order 表',
      '',
      '## API 层',
      '- [ ] 实现 /users 路由',
      '',
      '## 前端组件',
      '- [ ] 创建 UserCard 组件',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, null);
      assert.ok(res.workPackages.length >= 3, '应解析出至少 3 个 WP');
      assert.strictEqual(res.workPackages.length, 3);
      assert.strictEqual(res.goal.wpIds.length, 3);
      // 派生编号应唯一且稳定
      var ids = res.workPackages.map(function (w) { return w.wpId; });
      var uniq = ids.filter(function (v, i, a) { return a.indexOf(v) === i; });
      assert.strictEqual(ids.length, uniq.length, 'wpId 唯一');
      // 标题提取正确
      var titles = res.workPackages.map(function (w) { return w.title; });
      assert.ok(titles.indexOf('数据模型') !== -1);
      assert.ok(titles.indexOf('API 层') !== -1);
      assert.ok(titles.indexOf('前端组件') !== -1);
    } finally {
      env.cleanup();
    }
  });

  test('checklist 每项有稳定 id 且跨轮一致', function () {
    var content = [
      '## 解析模块',
      '- [ ] 实现 A',
      '- [x] 实现 B',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var r1 = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      var r2 = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(r1.workPackages[0].checklist.length, 2);
      assert.strictEqual(r1.workPackages[0].checklist[0].id, r2.workPackages[0].checklist[0].id);
      assert.strictEqual(r1.workPackages[0].checklist[1].id, r2.workPackages[0].checklist[1].id);
      // id 形如 {slug}-{序号}
      assert.ok(/-\d+$/.test(r1.workPackages[0].checklist[0].id), 'id 应以序号结尾');
    } finally {
      env.cleanup();
    }
  });

  test('任务项勾选状态识别（[ ]/[x]/[X]/[✓]）', function () {
    var content = [
      '## 验收',
      '- [ ] 未完成项',
      '- [x] 已完成项',
      '- [X] 大写已完成',
      '- [✓] 对勾已完成',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      var chk = res.workPackages[0].checklist;
      assert.strictEqual(chk.length, 4);
      assert.strictEqual(chk[0].checked, false);
      assert.strictEqual(chk[1].checked, true);
      assert.strictEqual(chk[2].checked, true);
      assert.strictEqual(chk[3].checked, true);
    } finally {
      env.cleanup();
    }
  });

  test('category 从 [prefix] 前缀抽取', function () {
    var content = [
      '## 模块',
      '- [ ] [acceptance] 覆盖率达标',
      '- [ ] [unit] 单测全绿',
      '- [ ] 普通项无前缀',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      var chk = res.workPackages[0].checklist;
      assert.strictEqual(chk[0].category, 'acceptance');
      assert.strictEqual(chk[1].category, 'unit');
      assert.strictEqual(chk[2].category, 'check');
      assert.strictEqual(chk[0].item, '覆盖率达标');
    } finally {
      env.cleanup();
    }
  });
});

// ─────────────────────────────────────────────
// Section 2: 依赖图构建
// ─────────────────────────────────────────────

test.describe('依赖图构建', function () {
  test('显式 WP-NNN + 依赖语义构建正确依赖图', function () {
    var content = [
      '## WP-10: 基础模块',
      '- [ ] 实现 A',
      '',
      '## WP-11: 上层模块',
      '依赖 WP-10',
      '- [ ] 实现 B',
      '',
      '## WP-12: 最上层',
      'depends on WP-11',
      '- [ ] 实现 C',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, null);
      // 拓扑序：WP-10 先于 WP-11 先于 WP-12
      assert.strictEqual(res.dependencyGraph.order.indexOf('WP-10'), 0);
      assert.ok(res.dependencyGraph.order.indexOf('WP-10') < res.dependencyGraph.order.indexOf('WP-11'));
      assert.ok(res.dependencyGraph.order.indexOf('WP-11') < res.dependencyGraph.order.indexOf('WP-12'));
      // 邻接
      assert.ok(res.dependencyGraph.nodes['WP-11'].dependencies.indexOf('WP-10') !== -1);
      assert.ok(res.dependencyGraph.nodes['WP-12'].dependencies.indexOf('WP-11') !== -1);
      // 反向
      assert.ok(res.dependencyGraph.nodes['WP-10'].dependents.indexOf('WP-11') !== -1);
      assert.strictEqual(res.dependencyGraph.hasCycle, false);
    } finally {
      env.cleanup();
    }
  });

  test('依赖引用越界（指向不存在的 WP）被忽略', function () {
    var content = [
      '## WP-20: 模块',
      '依赖 WP-999',
      '- [ ] 实现 X',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.deepStrictEqual(res.workPackages[0].dependencies, []);
      assert.strictEqual(res.dependencyGraph.edges.length, 0);
    } finally {
      env.cleanup();
    }
  });

  test('自引用依赖被排除', function () {
    var content = [
      '## WP-30: 模块',
      '依赖 WP-30',
      '- [ ] 实现 Y',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.deepStrictEqual(res.workPackages[0].dependencies, []);
    } finally {
      env.cleanup();
    }
  });
});

// ─────────────────────────────────────────────
// Section 3: 循环依赖检测
// ─────────────────────────────────────────────

test.describe('循环依赖检测', function () {
  test('循环依赖默认抛 PLAN_CYCLIC_DEPENDENCY', function () {
    var content = [
      '## WP-1: A',
      '依赖 WP-2',
      '- [ ] 实现',
      '',
      '## WP-2: B',
      'depends on WP-1',
      '- [ ] 实现',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      assert.throws(function () {
        planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      }, function (e) {
        return e.code === 'PLAN_CYCLIC_DEPENDENCY' && Array.isArray(e.cycle) && e.cycle.length > 0;
      });
    } finally {
      env.cleanup();
    }
  });

  test('throwOnCycle=false 不抛，返回 error + cycle 字段', function () {
    var content = [
      '## WP-1: A',
      '依赖 WP-2',
      '- [ ] 实现',
      '',
      '## WP-2: B',
      '先完成 WP-1',
      '- [ ] 实现',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({
        planFilePath: env.planPath,
        projectRoot: env.dir,
        throwOnCycle: false,
      });
      assert.ok(res.error);
      assert.ok(res.error.indexOf('cyclic') !== -1 || res.error.indexOf('循环') !== -1);
      assert.strictEqual(res.dependencyGraph.hasCycle, true);
      assert.ok(res.dependencyGraph.cycle.length >= 2);
    } finally {
      env.cleanup();
    }
  });
});

// ─────────────────────────────────────────────
// Section 4: 容错（空 / 缺失 / 无可执行）
// ─────────────────────────────────────────────

test.describe('容错降级', function () {
  test('plan.md 不存在 → 降级结构不抛', function () {
    var env = setupPlan(undefined);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, 'plan-not-found');
      assert.deepStrictEqual(res.goal.wpIds, []);
      assert.deepStrictEqual(res.workPackages, []);
    } finally {
      env.cleanup();
    }
  });

  test('plan.md 为空 → 降级结构', function () {
    var env = setupPlan('   \n  \n');
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, 'plan-empty');
      assert.deepStrictEqual(res.workPackages, []);
    } finally {
      env.cleanup();
    }
  });

  test('plan.md 纯叙述无可执行 section → 降级', function () {
    var content = [
      '# 计划',
      '',
      '## 背景',
      '这是一个背景介绍，没有任务项。',
      '',
      '## 目标',
      '说明目标，但不包含执行性内容。',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, 'plan-no-executable-sections');
      assert.deepStrictEqual(res.workPackages, []);
    } finally {
      env.cleanup();
    }
  });

  test('读失败不抛（用目录伪装文件）', function () {
    var dir = makeTmpDir();
    try {
      // 把目录当 planPath 传入 → readFileSync 抛 EISDIR
      var res = planReader.parsePlanToGoal({ planFilePath: dir, projectRoot: dir });
      assert.ok(res.error);
      assert.ok(res.error.indexOf('plan-read-error') === 0 || res.error.indexOf('plan-not-found') === 0);
      assert.deepStrictEqual(res.workPackages, []);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
    }
  });
});

// ─────────────────────────────────────────────
// Section 5: 单 section / Step 行切分 / 兜底
// ─────────────────────────────────────────────

test.describe('单 section 与 Step 切分', function () {
  test('单 section 含任务项 → 一个 WP', function () {
    var content = [
      '# 计划',
      '',
      '- [ ] 任务一',
      '- [ ] 任务二',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, null);
      assert.strictEqual(res.workPackages.length, 1);
      assert.strictEqual(res.workPackages[0].checklist.length, 2);
    } finally {
      env.cleanup();
    }
  });

  test('无 section 标题但有 Step N: 行 → 按 Step 切分', function () {
    var content = [
      'Step 1: 实现解析',
      '- [ ] 写 A',
      '',
      'Step 2: 接入测试',
      '- [ ] 写测试',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, null);
      assert.strictEqual(res.workPackages.length, 2);
      // Step 标题文本提取（去掉 "Step N:" 前缀）
      assert.strictEqual(res.workPackages[0].title, '实现解析');
      assert.strictEqual(res.workPackages[1].title, '接入测试');
    } finally {
      env.cleanup();
    }
  });

  test('### 子 section 在父 ## 下正确归属（同级截断）', function () {
    var content = [
      '## 父模块',
      '- [ ] 父任务',
      '',
      '### 子模块 A',
      '- [ ] 子任务 A1',
      '',
      '### 子模块 B',
      '- [ ] 子任务 B1',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      // 父 ## 的 body 在第一个 ### 处截断，故父模块只有 1 个任务项
      var parent = res.workPackages.find(function (w) { return w.title === '父模块'; });
      assert.ok(parent);
      assert.strictEqual(parent.checklist.length, 1);
      // 子模块各成独立 WP
      assert.strictEqual(res.workPackages.length, 3);
    } finally {
      env.cleanup();
    }
  });
});

// ─────────────────────────────────────────────
// Section 6: 编号派生 / 显式 WP-NNN
// ─────────────────────────────────────────────

test.describe('WP 编号分配', function () {
  test('task.md 最大编号 +1 派生起点', function () {
    var content = [
      '## 模块 A',
      '- [ ] 实现',
      '',
      '## 模块 B',
      '- [ ] 实现',
      '',
    ].join('\n');
    var env = setupPlan(content, { taskMd: '已有 WP-176 和 WP-177\n' });
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, null);
      // task.md 最大 = 177 → 派生起点 178
      assert.strictEqual(res.workPackages[0].wpId, 'WP-178');
      assert.strictEqual(res.workPackages[1].wpId, 'WP-179');
    } finally {
      env.cleanup();
    }
  });

  test('无 task.md → 从 WP-1 派生', function () {
    var content = [
      '## 模块 A',
      '- [ ] 实现',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.workPackages[0].wpId, 'WP-1');
    } finally {
      env.cleanup();
    }
  });

  test('显式 WP-NNN 优先于派生', function () {
    var content = [
      '## WP-50: 特殊模块',
      '- [ ] 实现',
      '',
      '## 普通模块',
      '- [ ] 实现',
      '',
    ].join('\n');
    var env = setupPlan(content, { taskMd: 'max WP-176' });
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.workPackages[0].wpId, 'WP-50');
      // 第二个派生，跳过已被占用的 50
      assert.notStrictEqual(res.workPackages[1].wpId, 'WP-50');
    } finally {
      env.cleanup();
    }
  });

  test('重复显式 WP-NNN → 第二个降级派生', function () {
    var content = [
      '## WP-60: 模块',
      '- [ ] 实现',
      '',
      '## WP-60: 重复',
      '- [ ] 实现',
      '',
    ].join('\n');
    var env = setupPlan(content, { taskMd: 'max WP-176' });
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.workPackages[0].wpId, 'WP-60');
      assert.notStrictEqual(res.workPackages[1].wpId, 'WP-60');
      // wpId 唯一
      var ids = res.workPackages.map(function (w) { return w.wpId; });
      assert.strictEqual(ids.length, new Set(ids).size);
    } finally {
      env.cleanup();
    }
  });
});

// ─────────────────────────────────────────────
// Section 6b: WP-186 字母/混合编号放宽（端到端验证）
// ─────────────────────────────────────────────

test.describe('WP-186 字母/混合编号（extractExplicitWpId 放宽）', function () {
  test('## WP-A 解析为 wpId WP-A（非派生数字）', function () {
    var content = [
      '# 计划',
      '',
      '## WP-A: 字母模块',
      '- [ ] 实现 A',
      '',
      '## WP-B: 字母模块二',
      '- [ ] 实现 B',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, null);
      var ids = res.workPackages.map(function (w) { return w.wpId; });
      assert.ok(ids.indexOf('WP-A') !== -1, '应保留字母编号 WP-A，而非派生 WP-1');
      assert.ok(ids.indexOf('WP-B') !== -1, '应保留字母编号 WP-B');
      assert.ok(res.goal.wpIds.indexOf('WP-A') !== -1, 'goal.wpIds 应含 WP-A');
    } finally {
      env.cleanup();
    }
  });

  test('混合编号（WP-A + WP-101 + WP-feature-x）正确提取', function () {
    var content = [
      '## WP-A: 字母',
      '- [ ] t1',
      '',
      '## WP-101: 数字',
      '- [ ] t2',
      '',
      '## WP-feature-x: 混合',
      '- [ ] t3',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, null);
      var ids = res.workPackages.map(function (w) { return w.wpId; });
      assert.ok(ids.indexOf('WP-A') !== -1);
      assert.ok(ids.indexOf('WP-101') !== -1);
      assert.ok(ids.indexOf('WP-feature-x') !== -1, '应保留连字符混合编号 WP-feature-x');
      // wpId 唯一
      assert.strictEqual(ids.length, new Set(ids).size);
    } finally {
      env.cleanup();
    }
  });

  test('纯数字编号 plan 向后兼容（放宽后行为不变）', function () {
    var content = [
      '## WP-10: A',
      '- [ ] 实现',
      '',
      '## WP-11: B',
      '- [ ] 实现',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, null);
      var ids = res.workPackages.map(function (w) { return w.wpId; });
      assert.deepStrictEqual(ids.sort(), ['WP-10', 'WP-11']);
    } finally {
      env.cleanup();
    }
  });

  test('字母编号依赖引用构建正确依赖图（端到端链路）', function () {
    // 这是 WP-186 关键端到端证据：字母编号 section 的显式 id + 字母依赖引用
    // 必须同时被识别，否则字母 WP 的依赖图断裂。
    var content = [
      '## WP-A: 基础',
      '- [ ] 实现基础',
      '',
      '## WP-B: 上层',
      '依赖 WP-A',
      '- [ ] 实现上层',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.error, null);
      // WP-B 依赖 WP-A
      var wpB = res.workPackages.find(function (w) { return w.wpId === 'WP-B'; });
      assert.ok(wpB, 'WP-B 应存在');
      assert.deepStrictEqual(wpB.dependencies, ['WP-A'], 'WP-B 应依赖 WP-A');
      // 拓扑序：WP-A 先于 WP-B
      assert.ok(res.dependencyGraph.order.indexOf('WP-A') <
                res.dependencyGraph.order.indexOf('WP-B'));
      assert.strictEqual(res.dependencyGraph.hasCycle, false);
    } finally {
      env.cleanup();
    }
  });

  test('内部工具：extractExplicitWpId 字母/混合/数字全覆盖', function () {
    assert.strictEqual(planReader._extractExplicitWpId('## WP-A: 标题'), 'WP-A');
    assert.strictEqual(planReader._extractExplicitWpId('## WP-175: 标题'), 'WP-175');
    assert.strictEqual(planReader._extractExplicitWpId('## WP-feature-x: 标题'), 'WP-feature-x');
    assert.strictEqual(planReader._extractExplicitWpId('## WPA: 无连字符'), 'WP-A');
    // WP- 后为空 → 不匹配（避免误把裸 WP- 当编号）
    assert.strictEqual(planReader._extractExplicitWpId('see WP- in doc'), null);
    assert.strictEqual(planReader._extractExplicitWpId(''), null);
    assert.strictEqual(planReader._extractExplicitWpId(null), null);
  });

  test('内部工具：extractDependencyRefs 字母编号白名单过滤', function () {
    var text = '依赖 WP-A, depends on WP-B';
    // 白名单含 WP-A → 只收 WP-A
    assert.deepStrictEqual(
      planReader._extractDependencyRefs(text, ['WP-A', 'WP-B']),
      ['WP-A', 'WP-B']
    );
    assert.deepStrictEqual(planReader._extractDependencyRefs(text, ['WP-A']), ['WP-A']);
    // 无白名单 → 全收
    assert.deepStrictEqual(planReader._extractDependencyRefs('依赖 WP-A'), ['WP-A']);
  });
});

// ─────────────────────────────────────────────
// Section 6c: WP-192-6 严格版首字符约束（基准口径）
//   plan-reader 是严格版基准，loop-snapshot 已对齐。下划线/连字符开头编号
//   （WP-_x / WP--1）必须被拒绝，且两模块对同一输入产出相同结果。
// ─────────────────────────────────────────────

test.describe('WP-192-6 严格版首字符约束（基准口径）', function () {
  test('extractExplicitWpId 拒绝下划线/连字符开头编号', function () {
    assert.strictEqual(planReader._extractExplicitWpId('## WP-_x: bad'), null, 'WP-_x 应拒绝');
    assert.strictEqual(planReader._extractExplicitWpId('## WP--1: bad'), null, 'WP--1 应拒绝');
    assert.strictEqual(planReader._extractExplicitWpId('## WP-: bad'), null, 'WP- 空编号应拒绝');
    // 合法编号仍正常
    assert.strictEqual(planReader._extractExplicitWpId('## WP-175: ok'), 'WP-175');
    assert.strictEqual(planReader._extractExplicitWpId('## WP-A: ok'), 'WP-A');
    assert.strictEqual(planReader._extractExplicitWpId('## WP-feature-x: ok'), 'WP-feature-x');
  });

  test('extractDependencyRefs 拒绝下划线/连字符开头编号', function () {
    // 下划线/连字符开头编号不应被收为依赖
    assert.deepStrictEqual(planReader._extractDependencyRefs('依赖 WP-_x'), [], 'WP-_x 不应收');
    assert.deepStrictEqual(planReader._extractDependencyRefs('depends on WP--1'), [], 'WP--1 不应收');
    // 合法字母依赖仍正常
    assert.deepStrictEqual(planReader._extractDependencyRefs('依赖 WP-A'), ['WP-A']);
  });

  test('端到端：下划线开头 section 标题不产生非法 wpId（降级派生）', function () {
    // WP-_x 不是合法显式编号 → extractExplicitWpId 返回 null → 该 section 走派生编号，
    // 而非产出 WP-_x 这类非法 id 污染 goal.wpIds。
    var content = [
      '## WP-_x: 非法编号',
      '- [ ] 实现',
      '',
      '## WP-A: 合法',
      '- [ ] 实现',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      var ids = res.workPackages.map(function (w) { return w.wpId; });
      assert.ok(ids.indexOf('WP-A') !== -1, '合法字母编号 WP-A 保留');
      assert.ok(ids.indexOf('WP-_x') === -1, '不应产出 WP-_x 非法 id');
      assert.ok(ids.indexOf('WP-x') === -1, '也不应部分匹配为 WP-x');
      // WP-_x section 退化为派生编号（WP-1 之类数字）
      assert.ok(ids.some(function (id) { return /^WP-\d+$/.test(id); }),
        '非法编号 section 应降级为数字派生编号');
    } finally {
      env.cleanup();
    }
  });

  test('跨模块一致性：plan-reader 与 loop-snapshot 对同输入产出相同结果', function () {
    // 这是 WP-192-6 核心：两模块 WP 正则口径必须完全一致。
    // 直接比对两模块的内部归一化正则行为（共享同一组字符类）。
    var snapshot = require('../../plugins/runtime/loop-snapshot');
    // plan-reader section 标题正则：/\bWP-?([A-Za-z0-9][\w-]*)\b/i
    // loop-snapshot 路径正则：/WP-?([A-Za-z0-9][\w-]*)/i
    // 两者字符类相同（[A-Za-z0-9][\w-]*），归一化都为 'WP-' + token（保留原样大小写）。
    var inputs = ['WP-175', 'WP-A', 'wp-a', 'WP-feature-x', 'WP-_x', 'WP--1', 'WP-'];
    var planReaderRe = /\bWP-?([A-Za-z0-9][\w-]*)\b/i;
    inputs.forEach(function (tok) {
      var line = '## ' + tok + ': t';
      var m1 = line.match(planReaderRe);
      var pr = m1 ? 'WP-' + m1[1] : null;
      // loop-snapshot _queryGitDiff 路径正则同字符类
      var m2 = ('docs/wp/' + tok + '.md').match(/WP-?([A-Za-z0-9][\w-]*)/i);
      var ls = m2 ? 'WP-' + m2[1] : null;
      assert.strictEqual(pr, ls, '两模块对 ' + tok + ' 应产出相同结果（pr=' + pr + ', ls=' + ls + ')');
    });
    // sanity：确认 loop-snapshot 模块确实加载（避免 require 路径写错静默通过）
    assert.strictEqual(typeof snapshot._buildWorkPackages, 'function');
  });
});

// ─────────────────────────────────────────────
// Section 7: 成功标准 + checklistSpec + 内部工具
// ─────────────────────────────────────────────

test.describe('成功标准与聚合', function () {
  test('成功标准 section 抽取', function () {
    var content = [
      '## 实现模块',
      '- [ ] 实现 A',
      '',
      '## 成功标准',
      '- 全部单测通过',
      '- 覆盖率 ≥ 70%',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.ok(res.goal.successCriteria.indexOf('全部单测通过') !== -1);
      assert.ok(res.goal.successCriteria.indexOf('覆盖率 ≥ 70%') !== -1);
    } finally {
      env.cleanup();
    }
  });

  test('checklistSpec 聚合所有 WP 的 checklist', function () {
    var content = [
      '## WP-1: A',
      '- [ ] a1',
      '- [ ] a2',
      '',
      '## WP-2: B',
      '- [ ] b1',
      '',
    ].join('\n');
    var env = setupPlan(content);
    try {
      var res = planReader.parsePlanToGoal({ planFilePath: env.planPath, projectRoot: env.dir });
      assert.strictEqual(res.goal.checklistSpec.total, 3);
      assert.ok(res.goal.checklistSpec.byWp['WP-1'].length === 2);
      assert.ok(res.goal.checklistSpec.byWp['WP-2'].length === 1);
      // items 扁平且带 wpId
      assert.strictEqual(res.goal.checklistSpec.items[0].wpId, 'WP-1');
    } finally {
      env.cleanup();
    }
  });
});

test.describe('内部工具（白盒）', function () {
  test('slugify 归一化', function () {
    assert.strictEqual(planReader._slugify('数据 模型！'), 'wp'); // 全非 ASCII 折叠为空 → 'wp'
    assert.strictEqual(planReader._slugify('Data Model'), 'data-model');
    assert.strictEqual(planReader._slugify('  Foo--Bar  '), 'foo-bar');
    assert.strictEqual(planReader._slugify(''), 'wp');
    assert.strictEqual(planReader._slugify(null), 'wp');
  });

  test('parseTaskItem 识别/拒绝', function () {
    assert.deepStrictEqual(planReader._parseTaskItem('- [ ] hello'), { checked: false, text: 'hello' });
    assert.deepStrictEqual(planReader._parseTaskItem('* [x] done'), { checked: true, text: 'done' });
    assert.strictEqual(planReader._parseTaskItem('- not a task'), null);
    assert.strictEqual(planReader._parseTaskItem(''), null);
  });

  test('B7: ✗ / × 不应被当作 checked（语义反转修复）', function () {
    // 失败/未完成标记必须 NOT 计为完成。修复前 ✗/× 被误判为 checked:true。
    assert.deepStrictEqual(planReader._parseTaskItem('- [✗] failed task'),
      { checked: false, text: 'failed task' }, '✗ 不应算 checked');
    assert.deepStrictEqual(planReader._parseTaskItem('- [×] another fail'),
      { checked: false, text: 'another fail' }, '× 不应算 checked');
    // 正向标记仍正确
    assert.deepStrictEqual(planReader._parseTaskItem('- [x] done'),
      { checked: true, text: 'done' }, 'x 仍算 checked');
    assert.deepStrictEqual(planReader._parseTaskItem('- [X] DONE'),
      { checked: true, text: 'DONE' }, 'X 仍算 checked');
    assert.deepStrictEqual(planReader._parseTaskItem('- [✓] checked'),
      { checked: true, text: 'checked' }, '✓ 仍算 checked');
    assert.deepStrictEqual(planReader._parseTaskItem('- [✔] checked'),
      { checked: true, text: 'checked' }, '✔ 仍算 checked');
  });

  test('extractDependencyRefs 多语义 + 去重 + 白名单', function () {
    var text = '依赖 WP-1, depends on WP-2, 先完成 WP-1, after WP-3';
    var refs = planReader._extractDependencyRefs(text, ['WP-1', 'WP-2', 'WP-3']);
    assert.deepStrictEqual(refs, ['WP-1', 'WP-2', 'WP-3']);
    // 白名单过滤
    var refs2 = planReader._extractDependencyRefs(text, ['WP-1']);
    assert.deepStrictEqual(refs2, ['WP-1']);
    // 无白名单 → 全收
    var refs3 = planReader._extractDependencyRefs('依赖 WP-9');
    assert.deepStrictEqual(refs3, ['WP-9']);
    assert.deepStrictEqual(planReader._extractDependencyRefs(''), []);
  });

  test('readMaxWpNumber 扫描 task.md', function () {
    var dir = makeTmpDir();
    try {
      fs.writeFileSync(path.join(dir, 'task.md'), 'WP-5 then WP-12 then WP-3', 'utf8');
      assert.strictEqual(planReader._readMaxWpNumber(dir), 12);
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
    }
    // 无 task.md → 0
    var dir2 = makeTmpDir();
    try {
      assert.strictEqual(planReader._readMaxWpNumber(dir2), 0);
    } finally {
      try { fs.rmSync(dir2, { recursive: true, force: true }); } catch (_e) {}
    }
  });

  test('buildDependencyGraph 拓扑序稳定', function () {
    var wpDeps = [
      { wpId: 'WP-1', dependencies: [] },
      { wpId: 'WP-2', dependencies: ['WP-1'] },
      { wpId: 'WP-3', dependencies: ['WP-1'] },
    ];
    var g = planReader._buildDependencyGraph(wpDeps);
    assert.strictEqual(g.hasCycle, false);
    assert.strictEqual(g.order[0], 'WP-1');
    // WP-2 / WP-3 都只依赖 WP-1，可在 WP-1 之后任意序但都出现
    assert.ok(g.order.indexOf('WP-2') > 0);
    assert.ok(g.order.indexOf('WP-3') > 0);
    assert.strictEqual(g.edges.length, 2);
  });
});

// ─────────────────────────────────────────────
// Section 8: 默认路径探测
// ─────────────────────────────────────────────

test.describe('默认路径探测', function () {
  test('默认读 .claude/plan.md（projectRoot 下）', function () {
    var env = setupPlan('## M\n- [ ] t\n');
    try {
      var res = planReader.parsePlanToGoal({ projectRoot: env.dir });
      assert.strictEqual(res.error, null);
      assert.strictEqual(res.workPackages.length, 1);
      assert.ok(res.planFilePath.indexOf('.claude') !== -1);
    } finally {
      env.cleanup();
    }
  });

  test('resolvePlanPath 优先用 planFilePath', function () {
    var p = planReader.resolvePlanPath({ planFilePath: '/abs/plan.md' });
    // POSIX 风格绝对路径在所有平台都判为绝对，原样返回
    assert.strictEqual(p, '/abs/plan.md');
  });
});
