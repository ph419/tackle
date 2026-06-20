/**
 * Unit tests for safe-path shared primitives (S4/S5/S6 修复的基础设施)
 * Run with: node --test test/runtime/test-safe-path.js
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');

var safePath = require('../../plugins/runtime/safe-path');

// ---------------------------------------------------------------------------
// validateSafeName / assertSafeName
// ---------------------------------------------------------------------------

test('validateSafeName：合法名称通过', function () {
  ['loop-1', 'WP-046', 'abc', 'a', 'A1-b_c', 'x'.repeat(64)].forEach(function (n) {
    assert.strictEqual(safePath.validateSafeName(n).ok, true, '应通过: ' + n);
  });
});

test('validateSafeName：拒绝路径穿越/分隔符（S4 核心）', function () {
  ['..', '../etc', '..\\..\\escaped', 'a/b', 'a\\b', 'a:b', 'foo/../bar'].forEach(function (n) {
    var r = safePath.validateSafeName(n);
    assert.strictEqual(r.ok, false, '应拒绝: ' + n);
  });
});

test('validateSafeName：拒绝空/非串/超长', function () {
  assert.strictEqual(safePath.validateSafeName('').ok, false);
  assert.strictEqual(safePath.validateSafeName(null).ok, false);
  assert.strictEqual(safePath.validateSafeName(undefined).ok, false);
  assert.strictEqual(safePath.validateSafeName(123).ok, false);
  assert.strictEqual(safePath.validateSafeName('x'.repeat(65)).ok, false);
});

test('assertSafeName：合法返回原值，非法抛错携带 label', function () {
  assert.strictEqual(safePath.assertSafeName('loop-1', 'loopId'), 'loop-1');
  assert.throws(function () { safePath.assertSafeName('..', 'loopId'); }, /Invalid loopId: invalid_chars/);
  assert.throws(function () { safePath.assertSafeName('', 'wpId'); }, /Invalid wpId: empty/);
});

// ---------------------------------------------------------------------------
// isWithin（S6 正确实现，替代 indexOf===0）
// ---------------------------------------------------------------------------

test('isWithin：/foo 不应被当作 /foobar 的父目录（S6 关键回归）', function () {
  // indexOf===0 的反模式会把这里判成 true；正确实现必须 false
  assert.strictEqual(safePath.isWithin('/foo', '/foobar/baz'), false);
});

test('isWithin：真正的子路径返回 true', function () {
  assert.strictEqual(safePath.isWithin('/a/b', '/a/b/c'), true);
  assert.strictEqual(safePath.isWithin('/a/b', '/a/b/c/d.txt'), true);
});

test('isWithin：逃逸父目录返回 false', function () {
  assert.strictEqual(safePath.isWithin('/a/b', '/a/c'), false);
  assert.strictEqual(safePath.isWithin('/a/b', '/a/b/../c'), false);
});

test('isWithin：完全相同不算包含（避免 rmSync 自删）', function () {
  assert.strictEqual(safePath.isWithin('/a/b', '/a/b'), false);
});

test('isWithin：非串输入返回 false', function () {
  assert.strictEqual(safePath.isWithin(null, '/a'), false);
  assert.strictEqual(safePath.isWithin('/a', 123), false);
});

// ---------------------------------------------------------------------------
// isSymlink（S5 cleanup 防护）
// ---------------------------------------------------------------------------

test('isSymlink：真实符号链接返回 true，普通目录返回 false', function () {
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-path-sym-'));
  try {
    var realTarget = path.join(dir, 'real');
    var realChild = path.join(realTarget, 'child.txt');
    fs.mkdirSync(realTarget);
    fs.writeFileSync(realChild, 'x');
    var link = path.join(dir, 'link');
    try { fs.symlinkSync(realTarget, link); } catch (_e) {
      // 无权限建链接（部分 CI/Windows）→ 跳过该断言
      return;
    }
    assert.strictEqual(safePath.isSymlink(link), true, '符号链接应识别为 true');
    assert.strictEqual(safePath.isSymlink(realTarget), false, '普通目录应 false');
    assert.strictEqual(safePath.isSymlink(path.join(dir, 'nope')), false, '不存在应 false');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
  }
});
