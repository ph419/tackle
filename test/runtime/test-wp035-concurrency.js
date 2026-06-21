/**
 * WP-035: Subagent 并发控制测试
 *
 * 原先位于 tests/wp-035-concurrency-test.js（不在 test/ 下，scripts/test-runner.js
 * 只扫描 test/，导致 CI 从未运行该文件）。迁入 test/runtime/ 后由 npm test 自动纳入。
 *
 * 测试覆盖:
 *   1. 配置文件加载（harness-config.yaml + plugin-registry.json）
 *   2. is_time_in_range() 正常范围 / 跨午夜 / 边界值
 *   3. get_max_concurrent() 时间匹配 + default_max 回退
 *   4. Phase C 并发上限限制
 *   5. 多 schedule 优先级匹配
 *
 * Run with: node --test test/runtime/test-wp035-concurrency.js
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

// ==================== 受测辅助函数 ====================
// （从原 WP-035 实现内联，与 skill-agent-dispatcher 的并发调度逻辑等价）

/**
 * 判断当前时间是否在范围内，支持跨午夜。
 * @param {string} current - HH:MM
 * @param {string} start   - HH:MM
 * @param {string} end     - HH:MM
 * @returns {boolean}
 */
function is_time_in_range(current, start, end) {
  if (start <= end) {
    // 正常范围: 14:00-18:00
    return start <= current && current < end;
  }
  // 跨午夜: 22:00-06:00
  return current >= start || current < end;
}

/**
 * 根据当前时间匹配 schedule，返回对应并发上限。
 * @param {object} config       - 并发配置对象
 * @param {Date}   current_time - 当前时间
 * @returns {number}
 */
function get_max_concurrent(config, current_time) {
  if (!config || !config.schedules) {
    return config ? config.default_max || 6 : 6;
  }

  var current_hhmm = current_time.toTimeString().slice(0, 5);
  for (var i = 0; i < config.schedules.length; i++) {
    var schedule = config.schedules[i];
    var start = schedule.time_range.start;
    var end = schedule.time_range.end;
    if (is_time_in_range(current_hhmm, start, end)) {
      return schedule.max_concurrent;
    }
  }

  return config.default_max || 6;
}

// ==================== 测试用例 ====================

test('配置文件加载：harness-config.yaml 与 plugin-registry.json 含正确并发配置', function () {
  var repoRoot = path.resolve(__dirname, '..', '..');

  var harnessConfigPath = path.join(repoRoot, 'templates', 'harness-config.yaml');
  var harnessConfig = fs.readFileSync(harnessConfigPath, 'utf8');

  assert.ok(harnessConfig.includes('agent_dispatcher:'),
    'harness-config.yaml 应包含 agent_dispatcher 配置节');
  assert.ok(harnessConfig.includes('concurrency:'),
    'agent_dispatcher 应包含 concurrency 配置');
  assert.ok(harnessConfig.includes('default_max:'),
    'concurrency 应包含 default_max 配置');
  assert.ok(harnessConfig.includes('schedules:'),
    'concurrency 应包含 schedules 配置');

  var registryPath = path.join(repoRoot, 'plugins', 'plugin-registry.json');
  var registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

  var dispatcherPlugin = registry.plugins.find(function (p) {
    return p.name === 'skill-agent-dispatcher';
  });
  assert.ok(dispatcherPlugin, 'plugin-registry.json 应包含 skill-agent-dispatcher 插件');
  assert.ok(dispatcherPlugin.config, 'skill-agent-dispatcher 应有 config 字段');
  assert.ok(dispatcherPlugin.config.concurrency, 'config 应包含 concurrency 配置');
  assert.strictEqual(dispatcherPlugin.config.concurrency.default_max, 6, '默认并发数应为 6');
  assert.ok(dispatcherPlugin.config.concurrency.schedules, '应有 schedules 配置');
  assert.strictEqual(dispatcherPlugin.config.concurrency.schedules.length, 1, '应有一个 schedule');
});

test('is_time_in_range：正常范围（含边界）', function () {
  var cases = [
    { current: '14:00', start: '14:00', end: '18:00', expected: true, desc: '刚好在开始时间' },
    { current: '15:30', start: '14:00', end: '18:00', expected: true, desc: '在范围内' },
    { current: '17:59', start: '14:00', end: '18:00', expected: true, desc: '接近结束时间' },
    { current: '18:00', start: '14:00', end: '18:00', expected: false, desc: '刚好在结束时间（不包含）' },
    { current: '13:59', start: '14:00', end: '18:00', expected: false, desc: '在开始时间之前' },
    { current: '19:00', start: '14:00', end: '18:00', expected: false, desc: '在结束时间之后' },
  ];
  for (var i = 0; i < cases.length; i++) {
    var c = cases[i];
    assert.strictEqual(is_time_in_range(c.current, c.start, c.end), c.expected,
      c.desc + ': 期望 ' + c.expected);
  }
});

test('is_time_in_range：跨午夜场景', function () {
  var cases = [
    { current: '22:00', start: '22:00', end: '06:00', expected: true, desc: '刚好在开始时间（跨午夜）' },
    { current: '23:59', start: '22:00', end: '06:00', expected: true, desc: '接近午夜（跨午夜）' },
    { current: '00:00', start: '22:00', end: '06:00', expected: true, desc: '午夜零点（跨午夜）' },
    { current: '03:30', start: '22:00', end: '06:00', expected: true, desc: '凌晨时段（跨午夜）' },
    { current: '05:59', start: '22:00', end: '06:00', expected: true, desc: '接近结束时间（跨午夜）' },
    { current: '06:00', start: '22:00', end: '06:00', expected: false, desc: '刚好在结束时间（跨午夜，不包含）' },
    { current: '21:59', start: '22:00', end: '06:00', expected: false, desc: '在开始时间之前（跨午夜）' },
    { current: '07:00', start: '22:00', end: '06:00', expected: false, desc: '在结束时间之后（跨午夜）' },
  ];
  for (var i = 0; i < cases.length; i++) {
    var c = cases[i];
    assert.strictEqual(is_time_in_range(c.current, c.start, c.end), c.expected,
      c.desc + ': 期望 ' + c.expected);
  }
});

test('is_time_in_range：start=end 边界值', function () {
  assert.strictEqual(is_time_in_range('12:00', '12:00', '12:00'), false,
    'start=end，当前时间等于该值');
  assert.strictEqual(is_time_in_range('12:01', '12:00', '12:00'), false,
    'start=end，当前时间大于该值');
});

test('get_max_concurrent：时间匹配', function () {
  var sampleConfig = {
    default_max: 6,
    schedules: [
      { name: 'peak', time_range: { start: '14:00', end: '18:00' }, max_concurrent: 3 }
    ]
  };
  var cases = [
    { time: '13:00', expected: 6, desc: '高峰时段前，使用 default_max' },
    { time: '14:00', expected: 3, desc: '刚好在高峰时段开始，使用 schedule.max_concurrent' },
    { time: '15:30', expected: 3, desc: '在高峰时段内，使用 schedule.max_concurrent' },
    { time: '18:00', expected: 6, desc: '刚好在高峰时段结束，使用 default_max' },
    { time: '19:00', expected: 6, desc: '高峰时段后，使用 default_max' },
  ];
  for (var i = 0; i < cases.length; i++) {
    var c = cases[i];
    var parts = c.time.split(':');
    var t = new Date();
    t.setHours(Number(parts[0]), Number(parts[1]), 0, 0);
    assert.strictEqual(get_max_concurrent(sampleConfig, t), c.expected,
      c.desc + ': 期望 ' + c.expected);
  }
});

test('get_max_concurrent：default_max 回退', function () {
  var cases = [
    { config: null, expected: 6, desc: '无配置' },
    { config: {}, expected: 6, desc: '空配置对象' },
    { config: { default_max: 10 }, expected: 10, desc: '有 default_max 但无 schedules' },
    { config: { default_max: 8, schedules: [] }, expected: 8, desc: '有 default_max 但 schedules 为空' },
    {
      config: { schedules: [{ name: 'peak', time_range: { start: '14:00', end: '18:00' }, max_concurrent: 3 }] },
      expected: 6,
      desc: '有 schedules 但无 default_max（回退到硬编码 6）'
    },
  ];
  var t = new Date();
  t.setHours(10, 0, 0, 0); // 10:00，不在任何 schedule 内
  for (var i = 0; i < cases.length; i++) {
    var c = cases[i];
    assert.strictEqual(get_max_concurrent(c.config, t), c.expected,
      c.desc + ': 期望 ' + c.expected);
  }
});

test('Phase C 并发上限限制模拟', function () {
  function simulate_phase_c(teamee_map_size, max_concurrent, pending_unblocked_count) {
    var can_create = [];
    var skipped = [];
    for (var i = 0; i < pending_unblocked_count; i++) {
      if (teamee_map_size >= max_concurrent) {
        skipped.push(i);
      } else {
        can_create.push(i);
        teamee_map_size++;
      }
    }
    return { can_create: can_create, skipped: skipped, final_active_count: teamee_map_size };
  }

  var cases = [
    { desc: '活跃数已达上限', active: 3, max: 3, pending: 5, expected_can_create: 0, expected_skipped: 5 },
    { desc: '活跃数接近上限', active: 2, max: 3, pending: 5, expected_can_create: 1, expected_skipped: 4 },
    { desc: '活跃数远低于上限', active: 1, max: 6, pending: 5, expected_can_create: 5, expected_skipped: 0 },
  ];
  for (var i = 0; i < cases.length; i++) {
    var c = cases[i];
    var result = simulate_phase_c(c.active, c.max, c.pending);
    assert.strictEqual(result.can_create.length, c.expected_can_create, c.desc + ': 可创建数');
    assert.strictEqual(result.skipped.length, c.expected_skipped, c.desc + ': 跳过数');
  }
});

test('多个 schedule 优先级匹配', function () {
  var multiScheduleConfig = {
    default_max: 8,
    schedules: [
      { name: 'off-peak', time_range: { start: '06:00', end: '14:00' }, max_concurrent: 6 },
      { name: 'peak', time_range: { start: '14:00', end: '18:00' }, max_concurrent: 3 },
      { name: 'evening', time_range: { start: '18:00', end: '22:00' }, max_concurrent: 4 }
    ]
  };
  var cases = [
    { time: '05:00', expected: 8, desc: '凌晨，不在任何 schedule' },
    { time: '10:00', expected: 6, desc: '上午，匹配 off-peak' },
    { time: '15:00', expected: 3, desc: '下午，匹配 peak' },
    { time: '20:00', expected: 4, desc: '晚上，匹配 evening' },
    { time: '23:00', expected: 8, desc: '深夜，不在任何 schedule' },
  ];
  for (var i = 0; i < cases.length; i++) {
    var c = cases[i];
    var parts = c.time.split(':');
    var t = new Date();
    t.setHours(Number(parts[0]), Number(parts[1]), 0, 0);
    assert.strictEqual(get_max_concurrent(multiScheduleConfig, t), c.expected,
      c.desc + ': 期望 ' + c.expected);
  }
});
